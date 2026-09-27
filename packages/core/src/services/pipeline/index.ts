import type { RawRequest } from '@ai-switchboard/sdk';

import { createExpressionEngine } from '../../expr/index.js';

import type { Ctx, PipelineDeps } from './context.js';
import { ingestPush, injectTestEvent, replayEvent } from './ingest.js';
import { maintenance } from './maintenance.js';
import {
  approve,
  clearSoftHold,
  closeRunByHand,
  readMetersNow,
  reject,
  resetBreaker,
  runNow,
} from './manual.js';
import { sendSystemAlert, type SystemAlert } from './notify.js';
import { handleCallback, recoverRuns } from './runs.js';
import { schedulerTick } from './scheduler.js';
import { registerWorkers, type WorkerHandle } from './workers.js';

export type { SecretResolver, PipelineDeps } from './context.js';
export { JOBS } from './context.js';
export { PipelineError, isPipelineError } from './errors.js';
export type { PipelineErrorCode } from './errors.js';
export type { SystemAlert } from './notify.js';
export { sendSystemAlert } from './notify.js';
export { countersFor, processRunCounts } from './counters.js';
export { latestReadings, meterSnapshots } from './meters.js';
export { materialiseStats } from './stats.js';
export { prune } from './retention.js';

export interface Pipeline {
  /**
   * POST /hooks/:sourceId. Verifies, stores the raw body, parses and validates inline, applies the
   * door rules and enqueues matching. 200 accepted (also for a disabled source), 401 rejected
   * (send an empty body), 404 unknown source, 503 when Postgres (or the live instance) is
   * unavailable so the sender retries.
   */
  ingestPush(sourceId: string, req: RawRequest): Promise<{ status: number }>;
  /** POST /callbacks/:executorId → verifyCallback → update or close the run. 401 on rejection, 404 unknown run/executor. */
  handleCallback(executorId: string, req: RawRequest): Promise<{ status: number }>;
  runNow(
    processId: string,
    opts: { dryRun?: boolean; batchId?: string; actor: string; reason: string },
  ): Promise<{ batchId: string; runId: string | null; outcome: string }>;
  approve(
    batchId: string,
    actor: string,
    reason: string,
  ): Promise<{ runId: string | null; outcome: string }>;
  reject(batchId: string, actor: string, reason: string): Promise<void>;
  /** Re-inject a stored raw body through the same parse; new events carry replayOf. */
  replay(eventId: string, actor: string, reason: string): Promise<{ eventIds: string[] }>;
  /** "Send test event": inject the source type's first example for `type` (or its first event type). */
  injectTestEvent(
    sourceId: string,
    type: string | undefined,
    actor: string,
    reason: string,
  ): Promise<{ eventIds: string[] }>;
  closeRun(
    runId: string,
    status: 'ok' | 'error' | 'unknown',
    actor: string,
    reason: string,
  ): Promise<void>;
  resetBreaker(processId: string, actor: string, reason: string): Promise<void>;
  clearSoftHold(executorId: string, actor: string, reason: string): Promise<void>;
  readMetersNow(executorId: string): Promise<void>;
  /** Register every queue worker and schedule, run startup recovery and start the heartbeat. */
  registerWorkers(): Promise<void>;

  // Beyond the API contract: hooks for the host, the server and tests.
  /** Send a system alert (e.g. the plugin host's load failures) to the system notifier. */
  systemAlert(alert: SystemAlert): Promise<boolean>;
  /** Run one scheduler tick now; returns the sweep batch ids fired. */
  schedulerTick(): Promise<string[]>;
  /** Run one maintenance pass now (lost-job recovery, claims, silent sources). */
  maintenance(): Promise<void>;
  /** Run startup recovery now. */
  recover(): Promise<void>;
  /** Stop the heartbeat timer (queue workers stop with the queue). */
  stop(): Promise<void>;
}

/** Build the pipeline over the given dependencies. Pure wiring; nothing runs until called. */
export function createPipeline(deps: PipelineDeps): Pipeline {
  const ctx: Ctx = {
    ...deps,
    engine: createExpressionEngine({ env: deps.env ?? process.env }),
    log: deps.logger.child({ component: 'pipeline' }),
  };
  let workers: WorkerHandle | null = null;
  return {
    ingestPush: (sourceId, req) => ingestPush(ctx, sourceId, req),
    handleCallback: (executorId, req) => handleCallback(ctx, executorId, req),
    runNow: (processId, opts) => runNow(ctx, processId, opts),
    approve: (batchId, actor, reason) => approve(ctx, batchId, actor, reason),
    reject: (batchId, actor, reason) => reject(ctx, batchId, actor, reason),
    replay: (eventId, actor, reason) => replayEvent(ctx, eventId, actor, reason),
    injectTestEvent: (sourceId, type, actor, reason) =>
      injectTestEvent(ctx, sourceId, type, actor, reason),
    closeRun: (runId, status, actor, reason) => closeRunByHand(ctx, runId, status, actor, reason),
    resetBreaker: (processId, actor, reason) => resetBreaker(ctx, processId, actor, reason),
    clearSoftHold: (executorId, actor, reason) => clearSoftHold(ctx, executorId, actor, reason),
    readMetersNow: (executorId) => readMetersNow(ctx, executorId),
    registerWorkers: async () => {
      if (workers) return;
      workers = await registerWorkers(ctx);
    },
    systemAlert: (alert) => sendSystemAlert(ctx, alert),
    schedulerTick: () => schedulerTick(ctx),
    maintenance: () => maintenance(ctx),
    recover: () => recoverRuns(ctx),
    stop: () => {
      workers?.stop();
      workers = null;
      return Promise.resolve();
    },
  };
}
