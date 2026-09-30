import {
  checkHealth,
  errorText,
  parseDefinitive,
  tryJson,
  tryParse,
  withSettings,
  type Destination,
  type DestinationType,
  type Health,
  type InvokeResult,
  type MeterReading,
  type PluginContext,
  type RunHandle,
  type RunStatus,
  type UsageReport,
} from '@ai-switchboard/sdk';

import { createApi, messageOf, refusal, repoPath } from './api.js';
import { createCorrelator } from './correlation.js';
import {
  dispatchedRun,
  durationFromRun,
  encodeRef,
  jobCount,
  rateLimitReading,
  stateOf,
  usageFromTiming,
  workflowRunSchema,
  type RunRef,
  type WorkflowRun,
} from './runs.js';
import {
  METERS,
  USAGE_DIMENSIONS,
  settingsSchema,
  type GithubActionsSettings,
} from './settings.js';
import {
  RUN_ID_INPUT,
  inputSchema,
  targetSchema,
  type WorkflowInputs,
  type WorkflowTarget,
} from './target.js';

/** Thrown when GitHub answers `poll` or `readMeters` unexpectedly. */
export class GithubActionsError extends Error {
  override readonly name = 'GithubActionsError';
}

function started(ref: RunRef, htmlUrl: string | undefined): InvokeResult {
  return {
    status: 'started',
    externalId: encodeRef(ref),
    ...(htmlUrl !== undefined ? { externalUrl: htmlUrl } : {}),
  };
}

function createGithubActionsDestination(
  settings: GithubActionsSettings,
  ctx: PluginContext,
): Destination {
  const api = createApi(settings, ctx);
  const correlator = createCorrelator(api, ctx);

  async function invoke(rawTarget: unknown, input: unknown, run: RunHandle): Promise<InvokeResult> {
    const target = parseDefinitive<WorkflowTarget>(targetSchema, rawTarget, 'workflow target');
    const inputs = {
      ...parseDefinitive<WorkflowInputs>(inputSchema, input ?? {}, 'workflow inputs'),
      [RUN_ID_INPUT]: run.id,
    };
    const workflow = String(target.workflow);
    await api.tokenOrThrow();
    const dispatchedAt = ctx.now().toISOString();
    const res = await api.request({
      method: 'POST',
      url: `${repoPath(target.owner, target.repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      json: { ref: target.ref, inputs, return_run_details: true },
    });
    if (!res.ok) return refusal(res, ctx.now());

    const { owner, repo } = target;
    const details = dispatchedRun(tryJson(res));
    if (details) return started({ owner, repo, runId: details.runId }, details.htmlUrl);
    // An older GitHub answers 204: find the run by its name.
    const pending = { owner, repo, workflow, dispatchedAt };
    const found = await correlator.find(pending, run.id);
    if (found) return started({ owner, repo, runId: found.id }, found.html_url);
    // Not listed yet: remember where to look so poll can correlate later.
    await correlator.remember(pending, run.id);
    return { status: 'started' };
  }

  async function usageOf(ref: RunRef, run: WorkflowRun): Promise<UsageReport> {
    const base = `${repoPath(ref.owner, ref.repo)}/actions/runs/${ref.runId}`;
    const usage: UsageReport = {};
    try {
      const timing = await api.request({ method: 'GET', url: `${base}/timing` });
      if (timing.ok) Object.assign(usage, usageFromTiming(tryJson(timing)));
    } catch (err) {
      ctx.logger.warn('workflow run timing unavailable', { error: errorText(err) });
    }
    if (usage.duration_seconds === undefined) {
      const duration = durationFromRun(run);
      if (duration !== undefined) usage.duration_seconds = duration;
    }
    try {
      const jobs = await api.request({
        method: 'GET',
        url: `${base}/jobs`,
        query: { filter: 'latest', per_page: 1 },
      });
      const total = jobs.ok ? jobCount(tryJson(jobs)) : undefined;
      if (total !== undefined) usage.jobs = total;
    } catch (err) {
      ctx.logger.warn('workflow run jobs unavailable', { error: errorText(err) });
    }
    return usage;
  }

  async function poll(run: RunHandle): Promise<RunStatus> {
    const ref = await correlator.locate(run);
    if (ref === 'missing') {
      return { state: 'unknown', errors: ['No workflow run is known for this run'] };
    }
    if (!ref) return { state: 'running' };
    const res = await api.request({
      method: 'GET',
      url: `${repoPath(ref.owner, ref.repo)}/actions/runs/${ref.runId}`,
    });
    if (res.status === 404) {
      return { state: 'unknown', errors: [`Workflow run ${ref.runId} no longer exists`] };
    }
    if (!res.ok) {
      throw new GithubActionsError(`GitHub answered ${res.status} for workflow run ${ref.runId}`);
    }
    const wf = tryParse<WorkflowRun>(workflowRunSchema, tryJson(res));
    if (!wf) throw new GithubActionsError(`Unexpected workflow run shape for ${ref.runId}`);
    const state = stateOf(wf);
    const externalUrl = wf.html_url !== undefined ? { externalUrl: wf.html_url } : {};
    if (state === 'running') return { state, ...externalUrl };
    const usage = await usageOf(ref, wf);
    return {
      state,
      ...externalUrl,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      ...(state === 'error'
        ? { errors: [`Workflow run concluded ${wf.conclusion ?? 'unknown'}`] }
        : {}),
      ...(wf.updated_at !== undefined ? { finishedAt: wf.updated_at } : {}),
    };
  }

  async function readMeters(): Promise<MeterReading[]> {
    const res = await api.request({ method: 'GET', url: '/rate_limit' });
    if (!res.ok) throw new GithubActionsError(`GitHub answered ${res.status} to /rate_limit`);
    const reading = rateLimitReading(tryJson(res), ctx.now().toISOString());
    if (!reading) throw new GithubActionsError('Unexpected /rate_limit shape');
    return [reading];
  }

  const health = (): Promise<Health> =>
    checkHealth(ctx, async () => {
      const res = await api.request({ method: 'GET', url: '/rate_limit' });
      if (res.ok) return { status: 'healthy' };
      return { status: 'unhealthy', message: `GitHub answered ${res.status}: ${messageOf(res)}` };
    });

  return { invoke, poll, readMeters, health };
}

export const githubActionsDestinationType: DestinationType = {
  id: 'github-actions',
  displayName: 'GitHub Actions',
  icon: 'play',
  description:
    'Dispatches a workflow_dispatch workflow and polls the run, correlated by a switchboard_run_id input.',
  settingsSchema,
  targetSchema,
  inputSchema,
  examples: [
    {
      target: { owner: 'acme', repo: 'api', workflow: 'triage.yml', ref: 'main' },
      input: { issue: '42', mode: 'event' },
    },
  ],
  tracking: 'poll',
  idempotentInvoke: false,
  // A token exchange, the dispatch and a correlation lookup, each bounded by the HttpClient's
  // 30 s timeout.
  invokeTimeoutSeconds: 120,
  usage: USAGE_DIMENSIONS,
  meters: METERS,
  create: withSettings(settingsSchema, 'github-actions settings', createGithubActionsDestination),
};
