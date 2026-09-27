import { JOBS, errorMessage, type Ctx } from './context.js';
import { dispatchBatch } from './dispatch.js';
import { pollSource } from './ingest.js';
import { attemptInvoke } from './invoke.js';
import { heartbeat, maintenance } from './maintenance.js';
import { fireBatch, matchEvent } from './match.js';
import { readMeters } from './meters.js';
import { prune } from './retention.js';
import { deadlineRun, finishRun, pollRun, recoverRuns } from './runs.js';
import { schedulerTick } from './scheduler.js';
import { materialiseStats } from './stats.js';

/** Queue handlers and schedules. Every handler takes ids and is idempotent. */

function id(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

export interface WorkerHandle {
  stop(): void;
}

export async function registerWorkers(ctx: Ctx): Promise<WorkerHandle> {
  const q = ctx.queue;
  const withId =
    (key: string, fn: (value: string) => Promise<unknown>) =>
    async (data: Record<string, unknown>): Promise<void> => {
      const value = id(data, key);
      if (value !== null) await fn(value);
    };

  await q.work(
    JOBS.match,
    withId('eventId', (v) => matchEvent(ctx, v)),
    { concurrency: 4 },
  );
  await q.work(
    JOBS.fire,
    withId('batchId', (v) => fireBatch(ctx, v)),
    { concurrency: 2 },
  );
  await q.work(
    JOBS.dispatch,
    withId('batchId', (v) => dispatchBatch(ctx, v)),
    { concurrency: 4 },
  );
  await q.work(
    JOBS.invoke,
    withId('runId', (v) => attemptInvoke(ctx, v)),
    { concurrency: 4 },
  );
  await q.work(
    JOBS.poll,
    withId('runId', (v) => pollRun(ctx, v)),
    { concurrency: 4 },
  );
  await q.work(
    JOBS.deadline,
    withId('runId', (v) => deadlineRun(ctx, v)),
    { concurrency: 2 },
  );
  await q.work(
    JOBS.finish,
    withId('runId', (v) => finishRun(ctx, v)),
    { concurrency: 2 },
  );
  await q.work(
    JOBS.sourcePoll,
    withId('sourceId', (v) => pollSource(ctx, v)),
    { concurrency: 2 },
  );
  await q.work(
    JOBS.metersRead,
    withId('executorId', (v) => readMeters(ctx, v)),
    { concurrency: 2 },
  );
  await q.work(JOBS.schedulerTick, async () => {
    await schedulerTick(ctx);
  });
  await q.work(JOBS.maintenance, () => maintenance(ctx));
  await q.work(JOBS.stats, async () => {
    const now = ctx.clock.now();
    await materialiseStats(ctx, new Date(now.getTime() - 3 * 3_600_000), now);
  });
  await q.work(JOBS.statsDeep, async () => {
    const now = ctx.clock.now();
    await materialiseStats(ctx, new Date(now.getTime() - 48 * 3_600_000), now);
  });
  await q.work(JOBS.prune, async () => {
    await prune(ctx);
  });

  await q.schedule(JOBS.schedulerTick, '* * * * *');
  await q.schedule(JOBS.maintenance, '* * * * *');
  await q.schedule(JOBS.stats, '*/10 * * * *');
  await q.schedule(JOBS.statsDeep, '7 * * * *');
  await q.schedule(JOBS.prune, '30 3 * * *');

  // Startup recovery: runs left `invoking` by a replica that stopped.
  try {
    await recoverRuns(ctx);
  } catch (err) {
    ctx.log.error({ err: errorMessage(err) }, 'startup recovery failed');
  }

  const startedAt = ctx.clock.now();
  const period = ctx.heartbeatIntervalMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  if (period > 0) {
    const beat = () => {
      heartbeat(ctx, startedAt).catch((err: unknown) => {
        ctx.log.warn({ err: errorMessage(err) }, 'heartbeat failed');
      });
    };
    beat();
    timer = setInterval(beat, period);
    timer.unref();
  }
  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
