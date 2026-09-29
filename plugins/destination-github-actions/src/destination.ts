import {
  InvokeError,
  invokeErrorForStatus,
  isTransportError,
  parseRetryAfter,
  type Destination,
  type DestinationType,
  type Health,
  type HttpRequest,
  type HttpResponse,
  type InvokeResult,
  type MeterReading,
  type PluginContext,
  type RunHandle,
  type RunStatus,
  type UsageReport,
  tryParse,
} from '@ai-switchboard/sdk';

import { GITHUB_HEADERS, GithubAuthError, createAuth } from './auth.js';
import {
  decodeRef,
  durationFromRun,
  encodeRef,
  matchesRun,
  runListSchema,
  stateOf,
  usageFromTiming,
  workflowRunSchema,
  type RunRef,
  type WorkflowRun,
} from './runs.js';
import {
  GITHUB_API,
  METERS,
  RATE_LIMIT_METER,
  USAGE_DIMENSIONS,
  readSettings,
  settingsSchema,
  type GithubActionsSettings,
} from './settings.js';
import {
  RUN_ID_INPUT,
  inputSchema,
  readInputs,
  readTarget,
  targetSchema,
  type WorkflowTarget,
} from './target.js';

const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** Look this far back from the dispatch when listing runs, for clock skew between us and GitHub. */
const CORRELATION_SKEW_MS = 2 * 60_000;
const CORRELATION_PAGE_SIZE = 50;
const CORRELATION_MAX_PAGES = 5;

/** Kept in instance state when a dispatch could not be correlated yet, so `poll` can find it. */
export interface PendingDispatch {
  owner: string;
  repo: string;
  workflow: string;
  dispatchedAt: string;
  runId?: number;
}

export const pendingKey = (runId: string): string => `dispatch:${runId}`;

function jsonBody(res: HttpResponse): unknown {
  try {
    return res.json();
  } catch {
    return undefined;
  }
}

function messageOf(res: HttpResponse): string {
  const body = jsonBody(res);
  if (body !== null && typeof body === 'object' && 'message' in body) {
    const message = body.message;
    if (typeof message === 'string') return message;
  }
  return res.text().slice(0, 200);
}

/** GitHub signals rate limits with 429, or 403 and `x-ratelimit-remaining: 0`. */
function rateLimitedFor(res: HttpResponse, now: Date): number | undefined {
  const limited =
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers['x-ratelimit-remaining'] === '0' || /rate limit/i.test(messageOf(res))));
  if (!limited) return undefined;
  const retryAfter = parseRetryAfter(res.headers['retry-after'], now);
  if (retryAfter !== undefined) return retryAfter;
  const reset = Number(res.headers['x-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, Math.ceil(reset - now.getTime() / 1000));
  }
  return DEFAULT_RETRY_AFTER_SECONDS;
}

/** Rate limits are returned; everything else throws. */
export function refusal(res: HttpResponse, now: Date): InvokeResult {
  const retryAfterSeconds = rateLimitedFor(res, now);
  const message = `GitHub answered ${res.status} to the dispatch: ${messageOf(res)}`;
  if (retryAfterSeconds !== undefined) {
    return { status: 'failed', retryAfterSeconds, errors: [message] };
  }
  // 404 (no such workflow or no access), 422 (no workflow_dispatch trigger, unknown input,
  // bad ref) and the other 4xx repeat on retry, so they are definitive.
  throw invokeErrorForStatus(res.status, message);
}

function createGithubActionsDestination(
  settings: GithubActionsSettings,
  ctx: PluginContext,
): Destination {
  const auth = createAuth(settings, ctx);

  async function api(req: HttpRequest): Promise<HttpResponse> {
    const token = await auth.token();
    const res = await ctx.http.request({
      ...req,
      url: `${GITHUB_API}${req.url}`,
      headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}`, ...req.headers },
    });
    if (res.status === 401) auth.invalidate();
    return res;
  }

  const repoPath = (owner: string, repo: string): string =>
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  /** A token failure happens before the dispatch is sent, so it is always safe to retry. */
  async function tokenOrThrow(): Promise<void> {
    try {
      await auth.token();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof GithubAuthError && err.status !== undefined && err.status < 500) {
        throw new InvokeError(message, { status: err.status, definitive: true, cause: err });
      }
      if (err instanceof GithubAuthError && err.status === undefined) {
        throw new InvokeError(message, { definitive: true, cause: err });
      }
      if (isTransportError(err) || err instanceof GithubAuthError) {
        throw new InvokeError(`Could not get a GitHub token: ${message}`, {
          sent: false,
          cause: err,
        });
      }
      throw err;
    }
  }

  /** Never throws. */
  async function correlate(
    owner: string,
    repo: string,
    workflow: string,
    runId: string,
    dispatchedAt: Date,
  ): Promise<WorkflowRun | undefined> {
    try {
      const since = new Date(dispatchedAt.getTime() - CORRELATION_SKEW_MS);
      // Newest first: a busy workflow can push our run past the first page before we look.
      for (let page = 1; page <= CORRELATION_MAX_PAGES; page++) {
        const res = await api({
          method: 'GET',
          url: `${repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs`,
          query: {
            event: 'workflow_dispatch',
            created: `>=${since.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
            per_page: CORRELATION_PAGE_SIZE,
            ...(page > 1 ? { page } : {}),
          },
        });
        if (!res.ok) return undefined;
        const list = tryParse<{ workflow_runs: WorkflowRun[] }>(runListSchema, jsonBody(res));
        const found = list?.workflow_runs.find((r) => matchesRun(r, runId));
        if (found || !list || list.workflow_runs.length < CORRELATION_PAGE_SIZE) return found;
      }
      return undefined;
    } catch (err) {
      ctx.logger.warn('workflow run correlation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  function started(ref: RunRef, htmlUrl: string | undefined): InvokeResult {
    return {
      status: 'started',
      externalId: encodeRef(ref),
      ...(htmlUrl !== undefined ? { externalUrl: htmlUrl } : {}),
    };
  }

  async function invoke(rawTarget: unknown, input: unknown, run: RunHandle): Promise<InvokeResult> {
    const target: WorkflowTarget = readTarget(rawTarget);
    const inputs = { ...readInputs(input), [RUN_ID_INPUT]: run.id };
    const workflow = String(target.workflow);
    await tokenOrThrow();
    const dispatchedAt = ctx.now();
    const res = await api({
      method: 'POST',
      url: `${repoPath(target.owner, target.repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      json: { ref: target.ref, inputs, return_run_details: true },
    });
    if (!res.ok) return refusal(res, ctx.now());

    // Newer GitHub answers 200 with the run; older answers 204 and we find the run by name.
    const details = jsonBody(res) as
      { workflow_run_id?: unknown; html_url?: unknown; run_url?: unknown } | undefined;
    if (typeof details?.workflow_run_id === 'number') {
      return started(
        { owner: target.owner, repo: target.repo, runId: details.workflow_run_id },
        typeof details.html_url === 'string' ? details.html_url : undefined,
      );
    }
    const found = await correlate(target.owner, target.repo, workflow, run.id, dispatchedAt);
    if (found) {
      return started({ owner: target.owner, repo: target.repo, runId: found.id }, found.html_url);
    }
    // Not listed yet: remember where to look so poll can correlate later.
    try {
      const pending: PendingDispatch = {
        owner: target.owner,
        repo: target.repo,
        workflow,
        dispatchedAt: dispatchedAt.toISOString(),
      };
      await ctx.state.set(pendingKey(run.id), pending);
    } catch (err) {
      ctx.logger.warn('could not record the pending dispatch', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { status: 'started' };
  }

  async function locate(run: RunHandle): Promise<RunRef | 'missing' | undefined> {
    const ref = decodeRef(run.externalId);
    if (ref) return ref;
    const pending = await ctx.state.get<PendingDispatch>(pendingKey(run.id));
    if (!pending) return 'missing';
    if (pending.runId !== undefined) {
      return { owner: pending.owner, repo: pending.repo, runId: pending.runId };
    }
    const found = await correlate(
      pending.owner,
      pending.repo,
      pending.workflow,
      run.id,
      new Date(pending.dispatchedAt),
    );
    if (!found) return undefined;
    await ctx.state.set(pendingKey(run.id), { ...pending, runId: found.id });
    return { owner: pending.owner, repo: pending.repo, runId: found.id };
  }

  async function usageOf(ref: RunRef, run: WorkflowRun): Promise<UsageReport> {
    const base = `${repoPath(ref.owner, ref.repo)}/actions/runs/${ref.runId}`;
    const usage: UsageReport = {};
    try {
      const timing = await api({ method: 'GET', url: `${base}/timing` });
      if (timing.ok) Object.assign(usage, usageFromTiming(jsonBody(timing)));
    } catch (err) {
      ctx.logger.warn('workflow run timing unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (usage.duration_seconds === undefined) {
      const duration = durationFromRun(run);
      if (duration !== undefined) usage.duration_seconds = duration;
    }
    try {
      const jobs = await api({
        method: 'GET',
        url: `${base}/jobs`,
        query: { filter: 'latest', per_page: 1 },
      });
      const total = (jsonBody(jobs) as { total_count?: unknown } | undefined)?.total_count;
      if (jobs.ok && typeof total === 'number') usage.jobs = total;
    } catch (err) {
      ctx.logger.warn('workflow run jobs unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return usage;
  }

  async function poll(run: RunHandle): Promise<RunStatus> {
    const ref = await locate(run);
    if (ref === 'missing') {
      return { state: 'unknown', errors: ['No workflow run is known for this run'] };
    }
    if (!ref) return { state: 'running' };
    const res = await api({
      method: 'GET',
      url: `${repoPath(ref.owner, ref.repo)}/actions/runs/${ref.runId}`,
    });
    if (res.status === 404) {
      return { state: 'unknown', errors: [`Workflow run ${ref.runId} no longer exists`] };
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for workflow run ${ref.runId}`);
    const wf = tryParse<WorkflowRun>(workflowRunSchema, jsonBody(res));
    if (!wf) throw new Error(`Unexpected workflow run shape for ${ref.runId}`);
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
    const res = await api({ method: 'GET', url: '/rate_limit' });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} to /rate_limit`);
    const core = (
      jsonBody(res) as
        { resources?: { core?: { limit?: unknown; used?: unknown; reset?: unknown } } } | undefined
    )?.resources?.core;
    if (typeof core?.limit !== 'number' || typeof core.used !== 'number' || core.limit <= 0) {
      throw new Error('Unexpected /rate_limit shape');
    }
    return [
      {
        id: RATE_LIMIT_METER,
        used: core.used,
        limit: core.limit,
        utilization: Math.min(100, Math.max(0, (core.used / core.limit) * 100)),
        ...(typeof core.reset === 'number'
          ? { resetsAt: new Date(core.reset * 1000).toISOString() }
          : {}),
        observedAt: ctx.now().toISOString(),
      },
    ];
  }

  async function health(): Promise<Health> {
    const checkedAt = (): string => ctx.now().toISOString();
    try {
      const res = await api({ method: 'GET', url: '/rate_limit' });
      if (res.ok) return { status: 'healthy', checkedAt: checkedAt() };
      return {
        status: 'unhealthy',
        message: `GitHub answered ${res.status}: ${messageOf(res)}`,
        checkedAt: checkedAt(),
      };
    } catch (err) {
      return {
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: checkedAt(),
      };
    }
  }

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
  create: (settings, ctx) => createGithubActionsDestination(readSettings(settings), ctx),
};
