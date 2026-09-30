import { eq } from 'drizzle-orm';

import type { RunHandle } from '@ai-switchboard/sdk';

import type { DbOrTx, Tx } from '../../../db/client.js';
import { batches, processes, runUpdates, runs } from '../../../db/schema.js';
import { withTx } from '../../../db/tx.js';
import { isTerminalRunStatus, type NotifyOn, type RunStatusValue } from '../../../domain/status.js';
import { neverInvoked } from '../../../pipeline/counted.js';
import { mergeRunUsage } from '../../../pipeline/run-usage.js';
import type { LiveDestination } from '../../../plugins/runtime.js';
import { callbackUrl } from '../../urls.js';
import { evaluateBreakerAfterClose } from '../breaker.js';
import type { Ctx } from '../context.js';
import { JOBS } from '../jobs.js';
import { batchEvents } from '../load.js';
import { notifyProcess, sendSystemAlert } from '../notify.js';
import { runSteps } from '../steps.js';
import { runView, type RunRow } from '../views.js';

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
  /** `0` marks a run nothing was sent for: it does not count toward budgets. */
  attempts?: number;
  /** Extra writes in the closing transaction (the audit row of a manual close). */
  inTx?: (tx: Tx) => Promise<void>;
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
    callbackUrl: callbackUrl(ctx.config.publicUrl, run.destinationId),
    deadline: (run.deadlineAt ?? ctx.clock.now()).toISOString(),
  };
}

/** Undeclared keys a destination reported are counted against its plugin. */
export function recordDroppedUsage(
  ctx: Pick<Ctx, 'runtime'>,
  live: LiveDestination | undefined,
  dropped: readonly string[],
): void {
  if (!live || dropped.length === 0) return;
  ctx.runtime.recordPluginError(
    live.pluginName,
    'invalid_usage',
    `undeclared usage keys: ${dropped.join(', ')}`,
  );
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
    const merged = mergeRunUsage(run.usage, input.usage, live(run.destinationId)?.usage ?? []);
    const [updated] = await tx
      .update(runs)
      .set({
        status: input.status,
        statusReason: input.reason ?? run.statusReason,
        finishedAt: now,
        ...(input.result !== undefined ? { result: input.result ?? null } : {}),
        usage: merged.usage,
        ...(input.errors !== undefined ? { errors: input.errors } : {}),
        ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
        externalId: run.externalId ?? input.externalId ?? null,
        externalUrl: input.externalUrl ?? run.externalUrl,
        invokeStartedAt: null,
        invokeDeadlineAt: null,
        nextPollAt: null,
      })
      .where(eq(runs.id, runId))
      .returning();
    await insertUpdate(tx, runId, now, input.source, input.status, {
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.errors && input.errors.length > 0 ? { errors: input.errors } : {}),
      ...(input.detail ?? {}),
    });
    await input.inTx?.(tx);
    const opened = await evaluateBreakerAfterClose(tx, run, input.status, now);
    return updated ? { closed: updated, dropped: merged.dropped, opened } : null;
  });
  if (!out) return false;
  const { closed, dropped, opened } = out;
  const ex = live(closed.destinationId);
  recordDroppedUsage(ctx, ex, dropped);

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

export function closeAtDeadline(ctx: Ctx, runId: string): Promise<boolean> {
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

/** A settled run's `after` steps and notifications. */
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

function insertUpdate(
  db: DbOrTx,
  runId: string,
  at: Date,
  source: UpdateSource,
  status: RunStatusValue,
  detail: Record<string, unknown>,
): Promise<unknown> {
  return db.insert(runUpdates).values({ runId, at, source, status, detail });
}

export async function recordUpdate(
  ctx: Ctx,
  runId: string,
  source: UpdateSource,
  status: RunStatusValue,
  detail: Record<string, unknown>,
): Promise<void> {
  await insertUpdate(ctx.db, runId, ctx.clock.now(), source, status, detail);
}
