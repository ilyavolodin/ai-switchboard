import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import {
  approvals,
  batches,
  destinations,
  processes,
  runs,
  type GateDecisionRecord,
} from '../../db/schema.js';
import { isTerminalRunStatus, type SettledRunStatus } from '../../domain/status.js';
import { recordAudit } from '../audit.js';

import { closeBreaker } from './breaker.js';
import type { Ctx } from './context.js';
import { dispatchBatch, type DispatchResult } from './dispatch.js';
import { PipelineError, findOrThrow } from './errors.js';
import { batchEvents } from './load.js';
import { readMeters } from './meters.js';
import { closeRun } from './runs.js';
import { appendDecisions, lockBatch, withTx } from './tx.js';

function requireReason(reason: string): void {
  if (reason.trim() === '') throw new PipelineError('invalid', 'a reason is required');
}

/**
 * With `batchId` it replays that batch's events. Dry runs pass every gate except approval, are
 * not counted toward budgets, and reach the destination with `run.dryRun = true`.
 */
export async function runNow(
  ctx: Ctx,
  processId: string,
  opts: { dryRun?: boolean; batchId?: string; actor: string; reason: string },
): Promise<DispatchResult> {
  requireReason(opts.reason);
  await findOrThrow('process', processId, async () => {
    const [row] = await ctx.db.select().from(processes).where(eq(processes.id, processId));
    return row;
  });
  let size = 0;
  const fromId = opts.batchId;
  if (fromId !== undefined) {
    const from = await findOrThrow('batch', fromId, async () => {
      const [row] = await ctx.db.select().from(batches).where(eq(batches.id, fromId));
      return row?.processId === processId ? row : undefined;
    });
    size = (await batchEvents(ctx.db, from)).length;
  }
  const now = ctx.clock.now();
  const batchId = randomUUID();
  const record: GateDecisionRecord = {
    stage: 'batch',
    check: 'manual',
    pass: true,
    detail: `${opts.dryRun === true ? 'test run' : 'run now'} by ${opts.actor}: ${opts.reason}`,
    at: now.toISOString(),
  };
  await withTx(ctx.db, async (tx) => {
    await tx.insert(batches).values({
      id: batchId,
      processId,
      batchKey: `manual:${batchId}`,
      kind: 'manual',
      openedAt: now,
      fireAfter: now,
      closedAt: now,
      size,
      outcome: 'closed',
      dryRun: opts.dryRun === true,
      requestedBy: opts.actor,
      eventsFrom: opts.batchId ?? null,
      decisions: [record],
    });
    await recordAudit(tx, {
      actor: opts.actor,
      scope: 'process',
      targetId: processId,
      field: opts.dryRun === true ? 'test_run' : 'run_now',
      after: { batchId, dryRun: opts.dryRun === true, fromBatch: opts.batchId ?? null },
      reason: opts.reason,
      at: now,
    });
  });
  return dispatchBatch(ctx, batchId);
}

/** The batch re-enters at the gate. */
export async function approve(
  ctx: Ctx,
  batchId: string,
  actor: string,
  reason: string,
): Promise<{ runId: string | null; outcome: string }> {
  requireReason(reason);
  await decide(ctx, batchId, 'approved', actor, reason);
  const out = await dispatchBatch(ctx, batchId);
  return { runId: out.runId, outcome: out.outcome };
}

export async function reject(
  ctx: Ctx,
  batchId: string,
  actor: string,
  reason: string,
): Promise<void> {
  requireReason(reason);
  const b = await decide(ctx, batchId, 'rejected', actor, reason);
  ctx.telemetry.decision(
    'switchboard.batches',
    { process: b.processId, kind: b.kind, outcome: 'rejected', reason: 'rejected' },
    { process_id: b.processId, batch_id: batchId },
  );
}

async function decide(
  ctx: Ctx,
  batchId: string,
  decision: 'approved' | 'rejected',
  actor: string,
  reason: string,
): Promise<{ processId: string; kind: string }> {
  const now = ctx.clock.now();
  return withTx(ctx.db, async (tx) => {
    const b = await findOrThrow('batch', batchId, () => lockBatch(tx, batchId));
    if (b.outcome !== 'awaiting_approval' || b.approvalState !== 'pending') {
      throw new PipelineError(
        'conflict',
        `batch ${batchId} is not awaiting approval (${b.outcome})`,
      );
    }
    const record: GateDecisionRecord = {
      stage: 'approval',
      check: decision,
      pass: decision === 'approved',
      detail: `${actor}: ${reason}`,
      at: now.toISOString(),
    };
    await tx
      .update(batches)
      .set({
        approvalState: decision,
        outcome: decision === 'approved' ? 'closed' : 'rejected',
        ...(decision === 'rejected' ? { outcomeReason: 'rejected' } : {}),
        decisions: appendDecisions([record]),
      })
      .where(eq(batches.id, batchId));
    await tx
      .update(approvals)
      .set({ decidedBy: actor, decidedAt: now, decision, reason })
      .where(eq(approvals.batchId, batchId));
    await recordAudit(tx, {
      actor,
      scope: 'approval',
      targetId: batchId,
      field: 'decision',
      before: 'pending',
      after: decision,
      reason,
      at: now,
    });
    return { processId: b.processId, kind: b.kind };
  });
}

export async function closeRunByHand(
  ctx: Ctx,
  runId: string,
  status: SettledRunStatus,
  actor: string,
  reason: string,
): Promise<void> {
  requireReason(reason);
  const run = await findOrThrow('run', runId, async () => {
    const [row] = await ctx.db.select().from(runs).where(eq(runs.id, runId));
    return row;
  });
  if (isTerminalRunStatus(run.status)) {
    throw new PipelineError('conflict', `run ${runId} is already ${run.status}`);
  }
  const closed = await closeRun(ctx, runId, {
    status,
    source: 'manual',
    reason: `closed by ${actor}: ${reason}`,
  });
  if (!closed) throw new PipelineError('conflict', `run ${runId} closed concurrently`);
  await recordAudit(ctx.db, {
    actor,
    scope: 'run',
    targetId: runId,
    field: 'status',
    before: run.status,
    after: status,
    reason,
    at: ctx.clock.now(),
  });
}

export async function resetBreaker(
  ctx: Ctx,
  processId: string,
  actor: string,
  reason: string,
): Promise<void> {
  requireReason(reason);
  const now = ctx.clock.now();
  await withTx(ctx.db, async (tx) => {
    const p = await findOrThrow('process', processId, async () => {
      const [row] = await tx
        .select()
        .from(processes)
        .where(eq(processes.id, processId))
        .for('update');
      return row;
    });
    await closeBreaker(tx, processId, now);
    await recordAudit(tx, {
      actor,
      scope: 'process',
      targetId: processId,
      field: 'breaker',
      before: p.breakerState,
      after: 'closed',
      reason,
      at: now,
    });
  });
  ctx.telemetry.gauge('switchboard.breaker', 0, { process: processId });
}

export async function clearSoftHold(
  ctx: Ctx,
  destinationId: string,
  actor: string,
  reason: string,
): Promise<void> {
  requireReason(reason);
  const now = ctx.clock.now();
  await withTx(ctx.db, async (tx) => {
    const e = await findOrThrow('destination', destinationId, async () => {
      const [row] = await tx
        .select()
        .from(destinations)
        .where(eq(destinations.id, destinationId))
        .for('update');
      return row;
    });
    await tx
      .update(destinations)
      .set({ softHoldUntil: null, softHoldReason: null })
      .where(eq(destinations.id, destinationId));
    await recordAudit(tx, {
      actor,
      scope: 'destination',
      targetId: destinationId,
      field: 'soft_hold_until',
      before: e.softHoldUntil?.toISOString() ?? null,
      after: null,
      reason,
      at: now,
    });
  });
}

export async function readMetersNow(ctx: Ctx, destinationId: string): Promise<void> {
  await findOrThrow('destination', destinationId, async () => {
    const [row] = await ctx.db
      .select({ id: destinations.id })
      .from(destinations)
      .where(eq(destinations.id, destinationId));
    return row;
  });
  if (!ctx.runtime.destination(destinationId)) {
    throw new PipelineError('unavailable', `destination ${destinationId} has no live instance`);
  }
  await readMeters(ctx, destinationId);
}
