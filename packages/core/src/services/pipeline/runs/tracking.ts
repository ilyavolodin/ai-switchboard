import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { RunStatus } from '@ai-switchboard/sdk';

import { runs } from '../../../db/schema.js';
import {
  OPEN_RUN_STATUSES,
  TRACKED_RUN_STATUSES,
  isOpenRunStatus,
  type RunStatusValue,
} from '../../../domain/status.js';
import { checkRunStatus } from '../../../pipeline/plugin-results.js';
import { mergeRunUsage } from '../../../pipeline/run-usage.js';
import { deadlinePassed, nextPollAt } from '../../../pipeline/tracking.js';
import type { Ctx } from '../context.js';
import { JOBS } from '../jobs.js';
import { callPlugin } from '../plugin-call.js';
import { runTarget } from '../target.js';
import type { RunRow } from '../views.js';

import {
  closeAtDeadline,
  closeRun,
  recordDroppedUsage,
  recordUpdate,
  runHandle,
  type UpdateSource,
} from './close.js';

/** With `attemptStartedAt`, only while that attempt is still the current one. */
export async function markUncertain(
  ctx: Ctx,
  runId: string,
  change: {
    source: UpdateSource;
    reason: string;
    detail: Record<string, unknown>;
    attemptStartedAt?: Date;
  },
): Promise<void> {
  const [moved] = await ctx.db
    .update(runs)
    .set({
      status: 'uncertain',
      statusReason: change.reason,
      invokeStartedAt: null,
      invokeDeadlineAt: null,
    })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.status, 'invoking'),
        change.attemptStartedAt ? eq(runs.invokeStartedAt, change.attemptStartedAt) : undefined,
      ),
    )
    .returning();
  if (!moved) return;
  await recordUpdate(ctx, runId, change.source, 'uncertain', change.detail);
  await scheduleTracking(ctx, moved, 0);
}

export async function scheduleTracking(ctx: Ctx, run: RunRow, pollCount: number): Promise<void> {
  const now = ctx.clock.now();
  const deadline = run.deadlineAt ?? now;
  const resolved = await runTarget(ctx, run);
  const tracking = resolved.ready ? resolved.live.trackingFor(resolved.target) : 'none';
  if (tracking === 'poll' && resolved.live?.destination.poll) {
    const next = nextPollAt(now, pollCount, deadline);
    await ctx.db.update(runs).set({ nextPollAt: next.at }).where(eq(runs.id, run.id));
    await ctx.queue.send(JOBS.poll, { runId: run.id }, { startAfter: next.at });
  }
  await ctx.queue.send(JOBS.deadline, { runId: run.id }, { startAfter: deadline });
}

/** A poll's or a callback's status: `running` updates the run, anything else settles it. */
export async function applyTracking(
  ctx: Ctx,
  run: RunRow,
  status: RunStatus,
  source: 'poll' | 'callback',
): Promise<void> {
  const next: RunStatusValue = status.state;
  if (next !== 'running') {
    await closeRun(ctx, run.id, {
      status: next,
      source,
      ...(status.usage !== undefined ? { usage: status.usage } : {}),
      ...(status.errors !== undefined ? { errors: status.errors } : {}),
      ...(status.externalUrl !== undefined ? { externalUrl: status.externalUrl } : {}),
      ...(status.outputs !== undefined ? { detail: { outputs: status.outputs } } : {}),
      ...(next === 'unknown' ? { reason: 'tracking reported unknown' } : {}),
    });
    return;
  }
  const live = ctx.runtime.destination(run.destinationId);
  const merged = mergeRunUsage(run.usage, status.usage, live?.usage ?? []);
  recordDroppedUsage(ctx, live, merged.dropped);
  const updated = await ctx.db
    .update(runs)
    .set({
      status: 'running',
      externalUrl: status.externalUrl ?? run.externalUrl,
      usage: merged.usage,
      ...(source === 'poll' ? { pollCount: run.pollCount + 1 } : {}),
    })
    .where(and(eq(runs.id, run.id), inArray(runs.status, OPEN_RUN_STATUSES)))
    .returning();
  const changed =
    run.status !== 'running' || (status.externalUrl ?? null) !== (run.externalUrl ?? null);
  if (updated.length > 0 && (changed || source === 'callback' || run.pollCount === 0)) {
    await recordUpdate(ctx, run.id, source, 'running', {
      ...(status.externalUrl ? { externalUrl: status.externalUrl } : {}),
      ...(run.status !== 'running' ? { from: run.status } : {}),
    });
  }
}

export function pollRun(ctx: Ctx, runId: string): Promise<void> {
  return ctx.telemetry.span(
    'switchboard.track',
    { run_id: runId, 'switchboard.track.via': 'poll' },
    () => pollRunInSpan(ctx, runId),
  );
}

async function pollRunInSpan(ctx: Ctx, runId: string): Promise<void> {
  const now = ctx.clock.now();
  const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId));
  if (!run || !isOpenRunStatus(run.status) || run.status === 'invoking') return;
  if (deadlinePassed(run.deadlineAt, now)) {
    await closeAtDeadline(ctx, runId);
    return;
  }
  if (run.nextPollAt && run.nextPollAt.getTime() > now.getTime()) {
    // An early (duplicate) job: the next poll is already scheduled.
    return;
  }
  const resolved = await runTarget(ctx, run);
  if (!resolved.ready) return;
  const { proc, live } = resolved;
  if (!live.destination.poll || live.trackingFor(resolved.target) !== 'poll') return;
  const poll = live.destination.poll.bind(live.destination);
  const next = nextPollAt(now, run.pollCount + 1, run.deadlineAt ?? now);
  // Claim this poll by moving `next_poll_at` on from the value read: a duplicate job running on
  // another replica at the same moment finds it moved and stops.
  const claimed = await ctx.db
    .update(runs)
    .set({ nextPollAt: next.at })
    .where(
      and(
        eq(runs.id, runId),
        inArray(runs.status, TRACKED_RUN_STATUSES),
        run.nextPollAt === null ? isNull(runs.nextPollAt) : eq(runs.nextPollAt, run.nextPollAt),
      ),
    )
    .returning({ id: runs.id });
  if (claimed.length === 0) return;

  const out = await callPlugin(ctx, live.pluginName, 'poll', () =>
    poll(runHandle(ctx, run, proc.name)),
  );
  let status: RunStatus | null = null;
  if (out.ok) {
    const checked = checkRunStatus(out.value);
    if (checked.ok) status = checked.value;
    else ctx.runtime.recordPluginError(live.pluginName, 'exception', `poll: ${checked.problem}`);
  } else {
    ctx.log.warn({ run_id: runId, err: out.error }, 'poll failed; will poll again');
  }
  if (status) {
    await applyTracking(ctx, run, status, 'poll');
    if (status.state !== 'running') return;
  } else {
    await ctx.db
      .update(runs)
      .set({ pollCount: run.pollCount + 1 })
      .where(eq(runs.id, runId));
  }
  await ctx.queue.send(
    next.atDeadline ? JOBS.deadline : JOBS.poll,
    { runId },
    { startAfter: next.at },
  );
}

export function deadlineRun(ctx: Ctx, runId: string): Promise<void> {
  return ctx.telemetry.span(
    'switchboard.track',
    { run_id: runId, 'switchboard.track.via': 'deadline' },
    () => deadlineRunInSpan(ctx, runId),
  );
}

async function deadlineRunInSpan(ctx: Ctx, runId: string): Promise<void> {
  const now = ctx.clock.now();
  const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId));
  if (!run || !isOpenRunStatus(run.status) || run.status === 'invoking') return;
  if (!deadlinePassed(run.deadlineAt, now)) {
    if (run.deadlineAt)
      await ctx.queue.send(JOBS.deadline, { runId }, { startAfter: run.deadlineAt });
    return;
  }
  await closeAtDeadline(ctx, runId);
}
