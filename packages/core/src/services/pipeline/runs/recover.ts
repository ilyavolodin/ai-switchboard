import { and, eq, inArray, lte } from 'drizzle-orm';

import { runs } from '../../../db/schema.js';
import { TRACKED_RUN_STATUSES } from '../../../domain/status.js';
import { lostPollCutoff, recoverInvoking } from '../../../pipeline/tracking.js';
import type { Ctx } from '../context.js';
import { JOBS, requeueJob, runJob, sendJob } from '../jobs.js';
import { beforeStepsSettled } from '../steps.js';
import { runTarget } from '../target.js';
import type { RunRow } from '../views.js';

import { closeAtDeadline } from './close.js';
import { markUncertain } from './tracking.js';

/**
 * Runs left `invoking` by a replica that stopped, runs past their deadline, and polls whose job
 * was lost. Every replica runs it each minute: a re-sent job is sent once per slot.
 */
export async function recoverRuns(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const invoking = await ctx.db.select().from(runs).where(eq(runs.status, 'invoking'));
  for (const run of invoking) await recoverInvokingRun(ctx, run, now);
  const overdue = await ctx.db
    .select({ id: runs.id })
    .from(runs)
    .where(and(inArray(runs.status, TRACKED_RUN_STATUSES), lte(runs.deadlineAt, now)));
  for (const r of overdue) await closeAtDeadline(ctx, r.id);
  const lostPolls = await ctx.db
    .select({ id: runs.id, traceContext: runs.traceContext })
    .from(runs)
    .where(
      and(inArray(runs.status, TRACKED_RUN_STATUSES), lte(runs.nextPollAt, lostPollCutoff(now))),
    );
  for (const r of lostPolls) await requeueJob(ctx.queue, JOBS.poll, runJob(r), r.id);
}

/**
 * An attempt that stopped in its `before` steps never reached `invoke`, so it is resumed even
 * when not idempotent; the step journal then decides what may run again.
 */
async function recoverInvokingRun(ctx: Ctx, run: RunRow, now: Date): Promise<void> {
  const resolved = await runTarget(ctx, run);
  const { proc } = resolved;
  const idempotent = resolved.ready ? resolved.live.idempotentFor(resolved.target) : false;
  let action = recoverInvoking(
    {
      status: run.status,
      invokeStartedAt: run.invokeStartedAt,
      invokeDeadlineAt: run.invokeDeadlineAt,
      createdAt: run.createdAt,
      retryAt: run.nextPollAt,
    },
    idempotent,
    now,
  );
  if (action === 'uncertain' && proc && !(await beforeStepsSettled(ctx, run.id, proc))) {
    action = 'reinvoke';
  }
  if (action === 'uncertain' && run.invokeStartedAt) {
    const since = Math.round((now.getTime() - run.invokeStartedAt.getTime()) / 1000);
    await markUncertain(ctx, run.id, {
      source: 'recovery',
      reason: `invoke attempt in flight past its deadline (${since} s)`,
      detail: {
        reason: 'invoking past its invoke deadline',
        invokeStartedAt: run.invokeStartedAt.toISOString(),
        invokeDeadlineAt: run.invokeDeadlineAt?.toISOString() ?? null,
      },
      attemptStartedAt: run.invokeStartedAt,
    });
  } else if (action === 'reinvoke' && run.invokeStartedAt) {
    // Claimed by clearing the attempt this replica read, so exactly one replica re-sends it.
    const moved = await ctx.db
      .update(runs)
      .set({ invokeStartedAt: null, invokeDeadlineAt: null })
      .where(
        and(
          eq(runs.id, run.id),
          eq(runs.status, 'invoking'),
          eq(runs.invokeStartedAt, run.invokeStartedAt),
        ),
      )
      .returning({ id: runs.id });
    if (moved.length > 0) await sendJob(ctx.queue, JOBS.invoke, runJob(run));
  } else if (action === 'resume') {
    await requeueJob(ctx.queue, JOBS.invoke, runJob(run), run.id);
  }
}
