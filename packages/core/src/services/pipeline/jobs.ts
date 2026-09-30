import type { JobQueue, SendOptions } from '../../queue/queue.js';
import { TRACEPARENT_KEY } from '../../queue/traced.js';

/** Jobs carry ids only. */
export const JOBS = {
  match: 'pipeline.match',
  fire: 'pipeline.fire',
  dispatch: 'pipeline.dispatch',
  invoke: 'pipeline.invoke',
  poll: 'pipeline.poll',
  deadline: 'pipeline.deadline',
  finish: 'pipeline.finish',
  sourcePoll: 'source.poll',
  metersRead: 'meters.read',
  schedulerTick: 'scheduler.tick',
  maintenance: 'pipeline.maintenance',
  stats: 'stats.materialise',
  statsDeep: 'stats.materialise.deep',
  prune: 'retention.prune',
} as const;

/** Handlers that start a span even with no trace to continue; housekeeping jobs don't. */
export const TRACED_JOBS: ReadonlySet<string> = new Set([
  JOBS.match,
  JOBS.fire,
  JOBS.dispatch,
  JOBS.invoke,
  JOBS.poll,
  JOBS.deadline,
  JOBS.finish,
  JOBS.sourcePoll,
  JOBS.metersRead,
]);

export type JobName = (typeof JOBS)[keyof typeof JOBS];

/** A sender may carry the trace to continue (`queue/traced.ts`). */
interface RunJob {
  runId: string;
  [TRACEPARENT_KEY]?: string;
}
type Housekeeping = Record<string, never>;

/** What each job carries: ids only, never payloads. */
export interface JobPayloads {
  [JOBS.match]: { eventId: string };
  [JOBS.fire]: { batchId: string };
  [JOBS.dispatch]: { batchId: string };
  [JOBS.invoke]: RunJob;
  [JOBS.poll]: RunJob;
  [JOBS.deadline]: RunJob;
  [JOBS.finish]: RunJob;
  [JOBS.sourcePoll]: { sourceId: string };
  [JOBS.metersRead]: { destinationId: string };
  [JOBS.schedulerTick]: Housekeeping;
  [JOBS.maintenance]: Housekeeping;
  [JOBS.stats]: Housekeeping;
  [JOBS.statsDeep]: Housekeeping;
  [JOBS.prune]: Housekeeping;
}

/** `queue.send` with the payload checked against the job's name. */
export function sendJob<N extends JobName>(
  queue: JobQueue,
  name: N,
  data: JobPayloads[N],
  options?: SendOptions,
): Promise<string | null> {
  return queue.send(name, { ...data }, options);
}

/** The job continues the run's trace (`queue/traced.ts`). */
export function runJob(run: { id: string; traceContext: string | null }): RunJob {
  return {
    runId: run.id,
    ...(run.traceContext !== null ? { [TRACEPARENT_KEY]: run.traceContext } : {}),
  };
}
