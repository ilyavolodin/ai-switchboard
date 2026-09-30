import type { RawRequest } from '@ai-switchboard/sdk';

import type { SettledRunStatus } from '../../domain/status.js';
import { traceQueue } from '../../queue/traced.js';
import type { ChangeMeta } from '../audit.js';

import type { Ctx, PipelineDeps } from './context.js';
import { expressionEngine } from './eval.js';
import { ingestPush, injectTestEvent, replayEvent } from './ingest.js';
import { TRACED_JOBS } from './jobs.js';
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
import type { IngressOutcome } from './outcomes.js';
import { handleCallback } from './runs/callback.js';
import { recoverRuns } from './runs/recover.js';
import { schedulerTick } from './scheduler.js';
import { registerWorkers, type WorkerHandle } from './workers.js';

export type { PipelineDeps } from './context.js';
export type { IngressOutcome } from './outcomes.js';
export { materialiseStats } from './stats.js';
export { prune } from './retention.js';

export interface Pipeline {
  /** `accepted` also for a disabled source; `unavailable` asks the sender to retry. */
  ingestPush(sourceId: string, req: RawRequest): Promise<IngressOutcome>;
  handleCallback(destinationId: string, req: RawRequest): Promise<IngressOutcome>;
  runNow(
    processId: string,
    opts: { dryRun?: boolean | undefined; batchId?: string | undefined },
    meta: ChangeMeta,
  ): Promise<{ batchId: string; runId: string | null; outcome: string }>;
  approve(batchId: string, meta: ChangeMeta): Promise<{ runId: string | null; outcome: string }>;
  reject(batchId: string, meta: ChangeMeta): Promise<void>;
  /** Re-parses the stored raw body; new events carry `replayOf`. */
  replay(eventId: string, meta: ChangeMeta): Promise<{ eventIds: string[] }>;
  /** Injects the source type's first example for `type` (or its first event type). */
  injectTestEvent(
    sourceId: string,
    type: string | undefined,
    meta: ChangeMeta,
  ): Promise<{ eventIds: string[] }>;
  closeRun(runId: string, status: SettledRunStatus, meta: ChangeMeta): Promise<void>;
  resetBreaker(processId: string, meta: ChangeMeta): Promise<void>;
  clearSoftHold(destinationId: string, meta: ChangeMeta): Promise<void>;
  readMetersNow(destinationId: string, meta: ChangeMeta): Promise<void>;
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
    engine: expressionEngine(deps),
    log: deps.logger.child({ component: 'pipeline' }),
  };
  let workers: WorkerHandle | null = null;
  return {
    ingestPush: (sourceId, req) => ingestPush(ctx, sourceId, req),
    handleCallback: (destinationId, req) => handleCallback(ctx, destinationId, req),
    runNow: (processId, opts, meta) => runNow(ctx, processId, opts, meta),
    approve: (batchId, meta) => approve(ctx, batchId, meta),
    reject: (batchId, meta) => reject(ctx, batchId, meta),
    replay: (eventId, meta) => replayEvent(ctx, eventId, meta),
    injectTestEvent: (sourceId, type, meta) => injectTestEvent(ctx, sourceId, type, meta),
    closeRun: (runId, status, meta) => closeRunByHand(ctx, runId, status, meta),
    resetBreaker: (processId, meta) => resetBreaker(ctx, processId, meta),
    clearSoftHold: (destinationId, meta) => clearSoftHold(ctx, destinationId, meta),
    readMetersNow: (destinationId, meta) => readMetersNow(ctx, destinationId, meta),
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
