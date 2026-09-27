import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';

import type { RawRequest, RunHandle, RunStatus } from '@ai-switchboard/sdk';

import { batches, executors, processes, runUpdates, runs } from '../../db/schema.js';
import {
  OPEN_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
  type RunStatusValue,
} from '../../domain/status.js';
import { breakerAfterRun } from '../../pipeline/breaker.js';
import {
  deadlinePassed,
  nextPollAt,
  recoverInvoking,
  statusFromTracking,
} from '../../pipeline/tracking.js';
import { mergeUsage, sanitizeUsage } from '../../pipeline/usage.js';

import { JOBS, callPlugin, withTx, type Ctx } from './context.js';
import { isUuid } from './errors.js';
import { batchEvents } from './load.js';
import { notifyProcess, sendSystemAlert, type NotifyOn } from './notify.js';
import { runSteps, runView, type RunRow } from './steps.js';

/**
 * Run lifecycle after invoke: tracking (poll, callback, deadline), closing a run with its usage,
 * the breaker, and the terminal follow-up (after steps and notifications).
 */

export type UpdateSource = 'invoke' | 'poll' | 'callback' | 'deadline' | 'manual' | 'recovery';

export interface CloseInput {
  status: RunStatusValue;
  source: UpdateSource;
  reason?: string | null;
  result?: unknown;
  /** Raw usage report from the plugin; validated against the declared dimensions here. */
  usage?: unknown;
  errors?: string[] | null;
  externalId?: string | null;
  externalUrl?: string | null;
  detail?: Record<string, unknown>;
}

function isOpen(status: RunStatusValue): boolean {
  return OPEN_RUN_STATUSES.includes(status);
}

/** The RunHandle executor methods receive for an existing run. */
export function runHandle(ctx: Ctx, run: RunRow, processName: string): RunHandle {
  return {
    id: run.id,
    processId: run.processId,
    processName,
    mode: run.kind,
    dryRun: run.dryRun,
    ...(run.externalId !== null ? { externalId: run.externalId } : {}),
    ...(run.externalUrl !== null ? { externalUrl: run.externalUrl } : {}),
    ...(run.invokedAt !== null ? { invokedAt: run.invokedAt.toISOString() } : {}),
    callbackUrl: `${ctx.config.publicUrl}/callbacks/${run.executorId}`,
    deadline: (run.deadlineAt ?? ctx.clock.now()).toISOString(),
  };
}

/**
 * Move a run to a terminal status. Idempotent: a run that is already terminal is left alone and
 * `false` is returned. Evaluates the breaker in the same transaction.
 */
export async function closeRun(ctx: Ctx, runId: string, input: CloseInput): Promise<boolean> {
  const now = ctx.clock.now();
  const live = (executorId: string) => ctx.runtime.executor(executorId);
  let dropped: { plugin: string; keys: string[] } | null = null;
  let opened: { processId: string; name: string; failures: number } | null = null;

  const closed = await withTx(ctx.db, async (tx) => {
    dropped = null;
    opened = null;
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
    if (!run || isTerminalRunStatus(run.status)) return null;
    const ex = live(run.executorId);
    let usage = run.usage;
    if (input.usage !== undefined) {
      const clean = sanitizeUsage(input.usage, ex?.usage ?? []);
      if (clean.dropped.length > 0 && ex) dropped = { plugin: ex.pluginName, keys: clean.dropped };
      usage = mergeUsage(run.usage, clean.usage, ex?.usage ?? []);
    }
    const [updated] = await tx
      .update(runs)
      .set({
        status: input.status,
        statusReason: input.reason ?? run.statusReason,
        finishedAt: now,
        ...(input.result !== undefined ? { result: input.result ?? null } : {}),
        usage,
        ...(input.errors !== undefined ? { errors: input.errors } : {}),
        externalId: run.externalId ?? input.externalId ?? null,
        externalUrl: input.externalUrl ?? run.externalUrl,
        invokeStartedAt: null,
        nextPollAt: null,
      })
      .where(eq(runs.id, runId))
      .returning();
    await tx.insert(runUpdates).values({
      runId,
      at: now,
      source: input.source,
      status: input.status,
      detail: {
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.errors && input.errors.length > 0 ? { errors: input.errors } : {}),
        ...(input.detail ?? {}),
      },
    });

    if (!run.dryRun && ['ok', 'error', 'unknown'].includes(input.status)) {
      const [proc] = await tx
        .select()
        .from(processes)
        .where(eq(processes.id, run.processId))
        .for('update');
      if (proc?.breakerState === 'closed') {
        const threshold = proc.document.gates.breaker.threshold;
        const recent = await tx
          .select({ status: runs.status })
          .from(runs)
          .where(
            and(
              eq(runs.processId, run.processId),
              eq(runs.dryRun, false),
              inArray(runs.status, [...TERMINAL_RUN_STATUSES]),
              isNotNull(runs.finishedAt),
              proc.breakerResetAt ? gt(runs.finishedAt, proc.breakerResetAt) : sql`true`,
            ),
          )
          .orderBy(desc(runs.finishedAt), desc(runs.createdAt))
          .limit(Math.max(threshold * 4, 50));
        const next = breakerAfterRun(
          { state: 'closed', openedAt: null },
          recent.map((r) => r.status),
          threshold,
          now,
        );
        if (next.transition === 'opened') {
          await tx
            .update(processes)
            .set({ breakerState: 'open', breakerOpenedAt: now })
            .where(eq(processes.id, run.processId));
          opened = { processId: proc.id, name: proc.name, failures: next.failures };
        }
      }
    }
    return updated ?? null;
  });
  if (!closed) return false;

  const d = dropped as { plugin: string; keys: string[] } | null;
  if (d)
    ctx.runtime.recordPluginError(
      d.plugin,
      'invalid_usage',
      `undeclared usage keys: ${d.keys.join(', ')}`,
    );
  const attrs = { process: closed.processId, executor: closed.executorId };
  ctx.telemetry.decision(
    'switchboard.runs',
    { ...attrs, status: closed.status },
    {
      process_id: closed.processId,
      batch_id: closed.batchId,
      run_id: closed.id,
      external_url: closed.externalUrl ?? undefined,
    },
  );
  if (closed.invokedAt) {
    ctx.telemetry.histogram(
      'switchboard.run.duration',
      (now.getTime() - closed.invokedAt.getTime()) / 1000,
      attrs,
    );
  }
  const ex = live(closed.executorId);
  for (const [dim, value] of Object.entries(closed.usage ?? {})) {
    const unit = ex?.usage.find((u) => u.id === dim)?.unit ?? 'count';
    ctx.telemetry.counter('switchboard.run.usage', { ...attrs, unit, dimension: dim }, value);
  }
  const o = opened as { processId: string; name: string; failures: number } | null;
  if (o) {
    ctx.telemetry.gauge('switchboard.breaker', 1, { process: o.processId });
    await sendSystemAlert(ctx, {
      key: `breaker:${o.processId}`,
      title: `Breaker opened: ${o.name}`,
      text: `Process ${o.name} had ${o.failures} consecutive failed runs; its batches and sweeps are held until the breaker is reset or its cooldown passes.`,
      severity: 'error',
      rateLimitMinutes: 1,
    });
  }
  await ctx.queue.send(JOBS.finish, { runId });
  return true;
}

function notifyOnFor(status: RunStatusValue): NotifyOn | null {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'error':
    case 'failed':
    case 'unknown':
      return 'error';
    case 'held':
      return 'held';
    case 'invoking':
    case 'running':
    case 'uncertain':
      return null;
  }
}

/** `pipeline.finish`: after steps and notifications on the terminal state. */
export async function finishRun(ctx: Ctx, runId: string): Promise<void> {
  const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId));
  if (!run || !isTerminalRunStatus(run.status)) return;
  const [proc] = await ctx.db.select().from(processes).where(eq(processes.id, run.processId));
  const [batch] = await ctx.db.select().from(batches).where(eq(batches.id, run.batchId));
  if (!proc || !batch) return;
  const events = await batchEvents(ctx.db, batch);
  const result = {
    status: run.status,
    result: run.result,
    usage: run.usage,
    errors: run.errors ?? [],
    externalUrl: run.externalUrl,
    reason: run.statusReason,
  };
  // A run that failed before invoke has no after phase.
  if (!(run.status === 'failed' && run.attempts === 0)) {
    await runSteps(ctx, 'after', run, proc, events, result);
  }
  const on = notifyOnFor(run.status);
  if (on && !run.dryRun) {
    await notifyProcess(ctx, {
      process: proc,
      on,
      batchId: run.batchId,
      runId: run.id,
      events,
      context: {
        run: runView(run),
        batch: { id: batch.id, kind: batch.kind },
        reason: run.statusReason,
      },
      url: run.externalUrl,
    });
  }
}

/** Append one entry to a run's tracking history (`run_updates`). */
export async function recordUpdate(
  ctx: Ctx,
  runId: string,
  source: UpdateSource,
  status: RunStatusValue,
  detail: Record<string, unknown>,
): Promise<void> {
  await ctx.db.insert(runUpdates).values({ runId, at: ctx.clock.now(), source, status, detail });
}

/**
 * Move an `invoking` run to `uncertain` (the invoke may have reached the backend) and schedule
 * tracking to settle it. With `attemptStartedAt`, only while that attempt is still the current
 * one. A run that already moved on is left alone.
 */
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
    .set({ status: 'uncertain', statusReason: change.reason, invokeStartedAt: null })
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

/** Schedule the tracking jobs for an open run: the next poll (poll tracking) and the deadline. */
export async function scheduleTracking(ctx: Ctx, run: RunRow, pollCount: number): Promise<void> {
  const now = ctx.clock.now();
  const deadline = run.deadlineAt ?? now;
  const live = ctx.runtime.executor(run.executorId);
  const [proc] = await ctx.db.select().from(processes).where(eq(processes.id, run.processId));
  const tracking = live && proc ? live.trackingFor(proc.document.executor.target) : 'none';
  if (tracking === 'poll' && live?.executor.poll) {
    const next = nextPollAt(now, pollCount, deadline);
    await ctx.db.update(runs).set({ nextPollAt: next.at }).where(eq(runs.id, run.id));
    await ctx.queue.send(JOBS.poll, { runId: run.id }, { startAfter: next.at });
  }
  await ctx.queue.send(JOBS.deadline, { runId: run.id }, { startAfter: deadline });
}

function validStatus(value: unknown): RunStatus | null {
  if (value === null || typeof value !== 'object') return null;
  const s = value as Partial<RunStatus>;
  if (s.state !== 'running' && s.state !== 'ok' && s.state !== 'error' && s.state !== 'unknown')
    return null;
  return s as RunStatus;
}

/** Apply a tracking report (poll or callback) to a run. */
async function applyTracking(
  ctx: Ctx,
  run: RunRow,
  status: RunStatus,
  source: 'poll' | 'callback',
): Promise<void> {
  const next = statusFromTracking(status.state);
  if (next === 'running') {
    const live = ctx.runtime.executor(run.executorId);
    const usage =
      status.usage !== undefined
        ? mergeUsage(
            run.usage,
            sanitizeUsage(status.usage, live?.usage ?? []).usage,
            live?.usage ?? [],
          )
        : run.usage;
    const updated = await ctx.db
      .update(runs)
      .set({
        status: 'running',
        externalUrl: status.externalUrl ?? run.externalUrl,
        usage,
        ...(source === 'poll' ? { pollCount: run.pollCount + 1 } : {}),
      })
      .where(and(eq(runs.id, run.id), inArray(runs.status, ['running', 'uncertain', 'invoking'])))
      .returning();
    const changed =
      run.status !== 'running' || (status.externalUrl ?? null) !== (run.externalUrl ?? null);
    if (updated.length > 0 && (changed || source === 'callback' || run.pollCount === 0)) {
      await recordUpdate(ctx, run.id, source, 'running', {
        ...(status.externalUrl ? { externalUrl: status.externalUrl } : {}),
        ...(run.status !== 'running' ? { from: run.status } : {}),
      });
    }
    return;
  }
  await closeRun(ctx, run.id, {
    status: next,
    source,
    ...(status.usage !== undefined ? { usage: status.usage } : {}),
    ...(status.errors !== undefined ? { errors: status.errors } : {}),
    ...(status.externalUrl !== undefined ? { externalUrl: status.externalUrl } : {}),
    ...(status.outputs !== undefined ? { detail: { outputs: status.outputs } } : {}),
    ...(next === 'unknown' ? { reason: 'tracking reported unknown' } : {}),
  });
}

/** `pipeline.poll` */
export async function pollRun(ctx: Ctx, runId: string): Promise<void> {
  const now = ctx.clock.now();
  const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId));
  if (!run || !isOpen(run.status) || run.status === 'invoking') return;
  if (deadlinePassed(run.deadlineAt, now)) {
    await closeRun(ctx, runId, { status: 'unknown', source: 'deadline', reason: 'deadline' });
    return;
  }
  if (run.nextPollAt && run.nextPollAt.getTime() > now.getTime()) {
    // An early (duplicate) job: the next poll is already scheduled.
    return;
  }
  const [proc] = await ctx.db.select().from(processes).where(eq(processes.id, run.processId));
  const live = ctx.runtime.executor(run.executorId);
  if (!proc || !live?.executor.poll || live.trackingFor(proc.document.executor.target) !== 'poll')
    return;
  const poll = live.executor.poll.bind(live.executor);
  const next = nextPollAt(now, run.pollCount + 1, run.deadlineAt ?? now);
  // Claim this poll by moving `next_poll_at` on from the value read: a duplicate job running on
  // another replica at the same moment finds it moved and stops.
  const claimed = await ctx.db
    .update(runs)
    .set({ nextPollAt: next.at })
    .where(
      and(
        eq(runs.id, runId),
        inArray(runs.status, ['running', 'uncertain']),
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
    status = validStatus(out.value);
    if (!status)
      ctx.runtime.recordPluginError(
        live.pluginName,
        'exception',
        'poll returned a malformed RunStatus',
      );
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

/** `pipeline.deadline`: an open run past its deadline becomes `unknown`. */
export async function deadlineRun(ctx: Ctx, runId: string): Promise<void> {
  const now = ctx.clock.now();
  const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId));
  if (!run || !isOpen(run.status) || run.status === 'invoking') return;
  if (!deadlinePassed(run.deadlineAt, now)) {
    if (run.deadlineAt)
      await ctx.queue.send(JOBS.deadline, { runId }, { startAfter: run.deadlineAt });
    return;
  }
  await closeRun(ctx, runId, { status: 'unknown', source: 'deadline', reason: 'deadline' });
}

/** POST /callbacks/:executorId */
export async function handleCallback(
  ctx: Ctx,
  executorId: string,
  req: RawRequest,
): Promise<{ status: number }> {
  if (!isUuid(executorId)) return { status: 404 };
  try {
    const [row] = await ctx.db.select().from(executors).where(eq(executors.id, executorId));
    if (!row) return { status: 404 };
    const live = ctx.runtime.executor(executorId);
    // No live instance right now (plugin unavailable, secret error): let the backend retry.
    if (!live) return { status: 503 };
    if (!live.executor.verifyCallback) return { status: 404 };
    let verified: { runId: string; status: unknown } | null = null;
    try {
      verified = live.executor.verifyCallback(req);
    } catch {
      // Counted against the plugin by the runtime's attribution wrapper; a rejection here.
      verified = null;
    }
    if (!verified) {
      ctx.log.warn(
        { executor_id: executorId, remote_address: req.remoteAddress },
        'callback rejected by verifyCallback',
      );
      await sendSystemAlert(ctx, {
        key: `callback_verification:${executorId}`,
        title: `Callback verification failed: ${row.name}`,
        text: `A callback to ${row.name} from ${req.remoteAddress ?? 'an unknown address'} failed verification and was rejected.`,
        severity: 'warning',
      });
      return { status: 401 };
    }
    if (!isUuid(verified.runId)) return { status: 404 };
    const [run] = await ctx.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, verified.runId), eq(runs.executorId, executorId)));
    if (!run) return { status: 404 };
    const status = validStatus(verified.status);
    if (!status) {
      ctx.runtime.recordPluginError(
        live.pluginName,
        'exception',
        'verifyCallback returned a malformed status',
      );
      return { status: 400 };
    }
    if (isTerminalRunStatus(run.status)) return { status: 200 };
    await applyTracking(ctx, run, status, 'callback');
    return { status: 200 };
  } catch (err) {
    ctx.log.error({ err, executor_id: executorId }, 'callback handling failed');
    return { status: 503 };
  }
}

/**
 * Recovery (at startup and every minute): `invoking` runs whose attempt started more than 60 s
 * ago become `uncertain` (or are re-invoked with the same run id when idempotent); runs whose
 * invoke job was lost are resumed; open runs past their deadline close as `unknown`.
 */
export async function recoverRuns(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const invoking = await ctx.db.select().from(runs).where(eq(runs.status, 'invoking'));
  for (const run of invoking) {
    const [proc] = await ctx.db.select().from(processes).where(eq(processes.id, run.processId));
    const live = ctx.runtime.executor(run.executorId);
    const idempotent = live && proc ? live.idempotentFor(proc.document.executor.target) : false;
    const action = recoverInvoking(
      {
        status: run.status,
        invokeStartedAt: run.invokeStartedAt,
        createdAt: run.createdAt,
        retryAt: run.nextPollAt,
      },
      idempotent,
      now,
    );
    if (action === 'uncertain' && run.invokeStartedAt) {
      await markUncertain(ctx, run.id, {
        source: 'recovery',
        reason: 'invoke attempt in flight for more than 60 s',
        detail: { reason: 'invoking older than 60 s' },
        attemptStartedAt: run.invokeStartedAt,
      });
    } else if (action === 'reinvoke' && run.invokeStartedAt) {
      const moved = await ctx.db
        .update(runs)
        .set({ invokeStartedAt: null })
        .where(
          and(
            eq(runs.id, run.id),
            eq(runs.status, 'invoking'),
            eq(runs.invokeStartedAt, run.invokeStartedAt),
          ),
        )
        .returning({ id: runs.id });
      if (moved.length > 0) await ctx.queue.send(JOBS.invoke, { runId: run.id });
    } else if (action === 'resume') {
      await ctx.queue.send(JOBS.invoke, { runId: run.id });
    }
  }
  const overdue = await ctx.db
    .select({ id: runs.id })
    .from(runs)
    .where(and(inArray(runs.status, ['running', 'uncertain']), lte(runs.deadlineAt, now)));
  for (const r of overdue)
    await closeRun(ctx, r.id, { status: 'unknown', source: 'deadline', reason: 'deadline' });
  const lostPolls = await ctx.db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        inArray(runs.status, ['running', 'uncertain']),
        lte(runs.nextPollAt, new Date(now.getTime() - 60_000)),
      ),
    );
  for (const r of lostPolls) await ctx.queue.send(JOBS.poll, { runId: r.id });
}
