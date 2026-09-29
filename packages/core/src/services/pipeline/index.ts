import type { RawRequest } from '@ai-switchboard/sdk';

import type { SettledRunStatus } from '../../domain/status.js';
import { createExpressionEngine } from '../../expr/index.js';

import { traceQueue } from '../../queue/traced.js';

import { TRACED_JOBS, type Ctx, type PipelineDeps } from './context.js';
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

export type { PipelineDeps } from './context.js';
export { materialiseStats } from './stats.js';
export { prune } from './retention.js';

export interface Pipeline {
  /**
   * 200 accepted (also for a disabled source), 401 rejected (send an empty body), 404 unknown
   * source, 503 when Postgres or the live instance is unavailable, so the sender retries.
   */
  ingestPush(sourceId: string, req: RawRequest): Promise<{ status: number }>;
  /** 401 on rejection, 404 unknown run or destination. */
  handleCallback(destinationId: string, req: RawRequest): Promise<{ status: number }>;
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
  /** Re-parses the stored raw body; new events carry `replayOf`. */
  replay(eventId: string, actor: string, reason: string): Promise<{ eventIds: string[] }>;
  /** Injects the source type's first example for `type` (or its first event type). */
  injectTestEvent(
    sourceId: string,
    type: string | undefined,
    actor: string,
    reason: string,
  ): Promise<{ eventIds: string[] }>;
  closeRun(runId: string, status: SettledRunStatus, actor: string, reason: string): Promise<void>;
  resetBreaker(processId: string, actor: string, reason: string): Promise<void>;
  clearSoftHold(destinationId: string, actor: string, reason: string): Promise<void>;
  readMetersNow(destinationId: string): Promise<void>;
  registerWorkers(): Promise<void>;

  // Beyond the API contract: hooks for the host, the server and tests.
  systemAlert(alert: SystemAlert): Promise<boolean>;
  /** Returns the sweep batch ids fired. */
  schedulerTick(): Promise<string[]>;
  maintenance(): Promise<void>;
  recover(): Promise<void>;
  /** Queue workers stop with the queue, not here. */
  stop(): Promise<void>;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const ctx: Ctx = {
    ...deps,
    queue: traceQueue(deps.queue, deps.telemetry, (name) => TRACED_JOBS.has(name)),
    engine: createExpressionEngine({ env: deps.env ?? process.env }),
    log: deps.logger.child({ component: 'pipeline' }),
  };
  let workers: WorkerHandle | null = null;
  return {
    ingestPush: (sourceId, req) => ingestPush(ctx, sourceId, req),
    handleCallback: (destinationId, req) => handleCallback(ctx, destinationId, req),
    runNow: (processId, opts) => runNow(ctx, processId, opts),
    approve: (batchId, actor, reason) => approve(ctx, batchId, actor, reason),
    reject: (batchId, actor, reason) => reject(ctx, batchId, actor, reason),
    replay: (eventId, actor, reason) => replayEvent(ctx, eventId, actor, reason),
    injectTestEvent: (sourceId, type, actor, reason) =>
      injectTestEvent(ctx, sourceId, type, actor, reason),
    closeRun: (runId, status, actor, reason) => closeRunByHand(ctx, runId, status, actor, reason),
    resetBreaker: (processId, actor, reason) => resetBreaker(ctx, processId, actor, reason),
    clearSoftHold: (destinationId, actor, reason) =>
      clearSoftHold(ctx, destinationId, actor, reason),
    readMetersNow: (destinationId) => readMetersNow(ctx, destinationId),
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
