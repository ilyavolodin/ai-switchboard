import { and, eq, inArray, isNull, lte } from 'drizzle-orm';

import type { RawRequest, RunHandle, RunStatus } from '@ai-switchboard/sdk';

import { batches, destinations, processes, runUpdates, runs } from '../../db/schema.js';
import {
  OPEN_RUN_STATUSES,
  TRACKED_RUN_STATUSES,
  isOpenRunStatus,
  isTerminalRunStatus,
  type NotifyOn,
  type RunStatusValue,
} from '../../domain/status.js';
import { neverInvoked } from '../../pipeline/counted.js';
import {
  deadlinePassed,
  isTrackingState,
  lostPollCutoff,
  nextPollAt,
  recoverInvoking,
} from '../../pipeline/tracking.js';
import { mergeUsage, sanitizeUsage } from '../../pipeline/usage.js';
import { isUuid } from '../../util/uuid.js';

import { evaluateBreakerAfterClose } from './breaker.js';
import type { Ctx } from './context.js';
import { JOBS, runJob } from './jobs.js';
import { batchEvents } from './load.js';
import { notifyProcess, sendSystemAlert } from './notify.js';
import { callPlugin } from './plugin-call.js';
import { beforeStepsSettled, runSteps } from './steps.js';
import { runTarget } from './target.js';
import { withTx } from './tx.js';
import { runView, type RunRow } from './views.js';

export type UpdateSource = 'invoke' | 'poll' | 'callback' | 'deadline' | 'manual' | 'recovery';

export interface CloseInput {
  status: RunStatusValue;
  source: UpdateSource;
  reason?: string | null;
  result?: unknown;
  /** Unvalidated; checked against the declared dimensions here. */
  usage?: unknown;
  errors?: string[] | null;
  externalId?: string | null;
  externalUrl?: string | null;
  detail?: Record<string, unknown>;
}

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
    callbackUrl: `${ctx.config.publicUrl}/callbacks/${run.destinationId}`,
    deadline: (run.deadlineAt ?? ctx.clock.now()).toISOString(),
  };
}

/**
 * Idempotent: an already terminal run is left alone and `false` is returned. Evaluates the
 * breaker in the same transaction.
 */
export async function closeRun(ctx: Ctx, runId: string, input: CloseInput): Promise<boolean> {
  const now = ctx.clock.now();
  const live = (destinationId: string) => ctx.runtime.destination(destinationId);

  const out = await withTx(ctx.db, async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
    if (!run || isTerminalRunStatus(run.status)) return null;
    const ex = live(run.destinationId);
    let usage = run.usage;
    let dropped: { plugin: string; keys: string[] } | null = null;
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
        invokeDeadlineAt: null,
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
    const opened = await evaluateBreakerAfterClose(tx, run, input.status, now);
    return updated ? { closed: updated, dropped, opened } : null;
  });
  if (!out) return false;
  const { closed, dropped, opened } = out;

  if (dropped) {
    ctx.runtime.recordPluginError(
      dropped.plugin,
      'invalid_usage',
      `undeclared usage keys: ${dropped.keys.join(', ')}`,
    );
  }
  const attrs = { process: closed.processId, destination: closed.destinationId };
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
  const ex = live(closed.destinationId);
  for (const [dim, value] of Object.entries(closed.usage ?? {})) {
    const unit = ex?.usage.find((u) => u.id === dim)?.unit ?? 'count';
    ctx.telemetry.counter('switchboard.run.usage', { ...attrs, unit, dimension: dim }, value);
  }
  if (opened) {
    ctx.telemetry.gauge('switchboard.breaker', 1, { process: opened.processId });
    await sendSystemAlert(ctx, {
      key: `breaker:${opened.processId}`,
      title: `Breaker opened: ${opened.name}`,
      text: `Process ${opened.name} had ${opened.failures} consecutive failed runs; its batches and sweeps are held until the breaker is reset or its cooldown passes.`,
      severity: 'error',
      rateLimitMinutes: 1,
    });
  }
  await ctx.queue.send(JOBS.finish, { runId });
  return true;
}

function closeAtDeadline(ctx: Ctx, runId: string): Promise<boolean> {
  return closeRun(ctx, runId, { status: 'unknown', source: 'deadline', reason: 'deadline' });
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
  if (!neverInvoked(run)) {
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

export async function recordUpdate(
  ctx: Ctx,
  runId: string,
  source: UpdateSource,
  status: RunStatusValue,
  detail: Record<string, unknown>,
): Promise<void> {
  await ctx.db.insert(runUpdates).values({ runId, at: ctx.clock.now(), source, status, detail });
}

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

function validStatus(value: unknown): RunStatus | null {
  if (value === null || typeof value !== 'object') return null;
  return isTrackingState((value as Partial<RunStatus>).state) ? (value as RunStatus) : null;
}

async function applyTracking(
  ctx: Ctx,
  run: RunRow,
  status: RunStatus,
  source: 'poll' | 'callback',
): Promise<void> {
  const next: RunStatusValue = status.state;
  if (next === 'running') {
    const live = ctx.runtime.destination(run.destinationId);
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

export async function handleCallback(
  ctx: Ctx,
  destinationId: string,
  req: RawRequest,
): Promise<{ status: number }> {
  if (!isUuid(destinationId)) return { status: 404 };
  try {
    const [row] = await ctx.db
      .select()
      .from(destinations)
      .where(eq(destinations.id, destinationId));
    if (!row) return { status: 404 };
    const live = ctx.runtime.destination(destinationId);
    // No live instance right now (plugin unavailable, secret error): let the backend retry.
    if (!live) return { status: 503 };
    if (!live.destination.verifyCallback) return { status: 404 };
    let verified: { runId: string; status: unknown } | null = null;
    try {
      verified = live.destination.verifyCallback(req);
    } catch {
      // Counted against the plugin by the runtime's attribution wrapper; a rejection here.
      verified = null;
    }
    if (!verified) {
      ctx.log.warn(
        { destination_id: destinationId, remote_address: req.remoteAddress },
        'callback rejected by verifyCallback',
      );
      await sendSystemAlert(ctx, {
        key: `callback_verification:${destinationId}`,
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
      .where(and(eq(runs.id, verified.runId), eq(runs.destinationId, destinationId)));
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
    // A child of the callback's HTTP span, linked to the trace that invoked the run.
    await ctx.telemetry.span(
      'switchboard.track',
      {
        run_id: run.id,
        process_id: run.processId,
        batch_id: run.batchId,
        'switchboard.track.via': 'callback',
        'switchboard.run.state': status.state,
      },
      () => applyTracking(ctx, run, status, 'callback'),
      { links: [run.traceContext] },
    );
    return { status: 200 };
  } catch (err) {
    ctx.log.error({ err, destination_id: destinationId }, 'callback handling failed');
    return { status: 503 };
  }
}

/**
 * An attempt that stopped in its `before` steps never reached `invoke`, so it is resumed even
 * when not idempotent; the step journal then decides what may run again.
 */
export async function recoverRuns(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const invoking = await ctx.db.select().from(runs).where(eq(runs.status, 'invoking'));
  for (const run of invoking) {
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
      if (moved.length > 0) await ctx.queue.send(JOBS.invoke, runJob(run));
    } else if (action === 'resume') {
      await ctx.queue.send(JOBS.invoke, runJob(run));
    }
  }
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
  for (const r of lostPolls) await ctx.queue.send(JOBS.poll, runJob(r));
}
