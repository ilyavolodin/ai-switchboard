import {
  errorText,
  tryJson,
  tryParse,
  type PluginContext,
  type RunHandle,
} from '@ai-switchboard/sdk';

import { repoPath, type GithubApi } from './api.js';
import { decodeRef, matchesRun, runListSchema, type RunRef, type WorkflowRun } from './runs.js';

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

export interface Correlator {
  /** The workflow run named after `runId`, dispatched around `dispatchedAt`. Never throws. */
  find(pending: Omit<PendingDispatch, 'runId'>, runId: string): Promise<WorkflowRun | undefined>;
  /** Remembers a dispatch `find` could not see yet. Never throws. */
  remember(pending: PendingDispatch, runId: string): Promise<void>;
  /** The run behind a Switchboard run: `missing` when nothing is known, `undefined` while unlisted. */
  locate(run: RunHandle): Promise<RunRef | 'missing' | undefined>;
}

export function createCorrelator(api: GithubApi, ctx: PluginContext): Correlator {
  async function find(
    pending: Omit<PendingDispatch, 'runId'>,
    runId: string,
  ): Promise<WorkflowRun | undefined> {
    try {
      const since = new Date(Date.parse(pending.dispatchedAt) - CORRELATION_SKEW_MS);
      const url = `${repoPath(pending.owner, pending.repo)}/actions/workflows/${encodeURIComponent(pending.workflow)}/runs`;
      // Newest first: a busy workflow can push our run past the first page before we look.
      for (let page = 1; page <= CORRELATION_MAX_PAGES; page++) {
        const res = await api.request({
          method: 'GET',
          url,
          query: {
            event: 'workflow_dispatch',
            created: `>=${since.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
            per_page: CORRELATION_PAGE_SIZE,
            ...(page > 1 ? { page } : {}),
          },
        });
        if (!res.ok) return undefined;
        const list = tryParse<{ workflow_runs: WorkflowRun[] }>(runListSchema, tryJson(res));
        const found = list?.workflow_runs.find((r) => matchesRun(r, runId));
        if (found || !list || list.workflow_runs.length < CORRELATION_PAGE_SIZE) return found;
      }
      return undefined;
    } catch (err) {
      ctx.logger.warn('workflow run correlation failed', { error: errorText(err) });
      return undefined;
    }
  }

  async function remember(pending: PendingDispatch, runId: string): Promise<void> {
    try {
      await ctx.state.set(pendingKey(runId), pending);
    } catch (err) {
      ctx.logger.warn('could not record the pending dispatch', { error: errorText(err) });
    }
  }

  async function locate(run: RunHandle): Promise<RunRef | 'missing' | undefined> {
    const ref = decodeRef(run.externalId);
    if (ref) return ref;
    const pending = await ctx.state.get<PendingDispatch>(pendingKey(run.id));
    if (!pending) return 'missing';
    if (pending.runId !== undefined) {
      return { owner: pending.owner, repo: pending.repo, runId: pending.runId };
    }
    const found = await find(pending, run.id);
    if (!found) return undefined;
    await ctx.state.set(pendingKey(run.id), { ...pending, runId: found.id });
    return { owner: pending.owner, repo: pending.repo, runId: found.id };
  }

  return { find, remember, locate };
}
