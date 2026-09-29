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

/** The job continues the run's trace (`queue/traced.ts`). */
export function runJob(run: { id: string; traceContext: string | null }): Record<string, unknown> {
  return {
    runId: run.id,
    ...(run.traceContext !== null ? { [TRACEPARENT_KEY]: run.traceContext } : {}),
  };
}
