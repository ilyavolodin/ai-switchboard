import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { approvals, batches, destinations, processes, runs } from '../../db/schema.js';
import { appendDecisions, withTx } from '../../db/tx.js';
import { isTerminalRunStatus, type SettledRunStatus } from '../../domain/status.js';
import { approvalRecord, batchRecord } from '../../pipeline/decisions.js';
import { auditChange, type ChangeMeta } from '../audit.js';
import { conflict, unavailable } from '../errors.js';
import { findOrThrow, requireById } from '../lookup.js';

import { closeBreaker } from './breaker.js';
import type { Ctx } from './context.js';
import { dispatchBatch, type DispatchResult } from './dispatch.js';
import { batchEvents } from './load.js';
import { readMeters } from './meters.js';
import { closeRun } from './runs/close.js';
import { insertClosedBatch, lockBatch } from './tx.js';

/**
 * With `batchId` it replays that batch's events. Dry runs pass every gate except approval, are
 * not counted toward budgets, and reach the destination with `run.dryRun = true`.
 */
export async function runNow(
  ctx: Ctx,
  processId: string,
  opts: { dryRun?: boolean | undefined; batchId?: string | undefined },
  meta: ChangeMeta,
): Promise<DispatchResult> {
  await requireById(ctx.db, processes, processId, 'Process');
  const fromId = opts.batchId;
  let size = 0;
  if (fromId !== undefined) {
    const from = await findOrThrow('Batch', fromId, async () => {
      const [row] = await ctx.db.select().from(batches).where(eq(batches.id, fromId));
      return row?.processId === processId ? row : undefined;
    });
    size = (await batchEvents(ctx.db, from)).length;
  }
  const dryRun = opts.dryRun === true;
  const batchId = randomUUID();
  const detail = `${dryRun ? 'test run' : 'run now'} by ${meta.actor}: ${meta.reason}`;
  await withTx(ctx.db, async (tx) => {
    await insertClosedBatch(tx, meta.now, {
      id: batchId,
      processId,
      batchKey: `manual:${batchId}`,
      kind: 'manual',
      size,
      dryRun,
      requestedBy: meta.actor,
      eventsFrom: fromId ?? null,
      decisions: [batchRecord('manual', meta.now, detail)],
    });
    await auditChange(tx, meta, {
      scope: 'process',
      targetId: processId,
      field: dryRun ? 'test_run' : 'run_now',
      after: { batchId, dryRun, fromBatch: fromId ?? null },
    });
  });
  return dispatchBatch(ctx, batchId);
}

/** The batch re-enters at the gate. */
export async function approve(
  ctx: Ctx,
  batchId: string,
  meta: ChangeMeta,
): Promise<{ runId: string | null; outcome: string }> {
  await decide(ctx, batchId, 'approved', meta);
  const out = await dispatchBatch(ctx, batchId);
  return { runId: out.runId, outcome: out.outcome };
}

export async function reject(ctx: Ctx, batchId: string, meta: ChangeMeta): Promise<void> {
  const b = await decide(ctx, batchId, 'rejected', meta);
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
  meta: ChangeMeta,
): Promise<{ processId: string; kind: string }> {
  return withTx(ctx.db, async (tx) => {
    const b = await findOrThrow('Batch', batchId, () => lockBatch(tx, batchId));
    if (b.outcome !== 'awaiting_approval' || b.approvalState !== 'pending') {
      throw conflict(`batch ${batchId} is not awaiting approval (${b.outcome})`);
    }
    await tx
      .update(batches)
      .set({
        approvalState: decision,
        outcome: decision === 'approved' ? 'closed' : 'rejected',
        ...(decision === 'rejected' ? { outcomeReason: 'rejected' } : {}),
        decisions: appendDecisions([
          approvalRecord(decision, `${meta.actor}: ${meta.reason}`, meta.now),
        ]),
      })
      .where(eq(batches.id, batchId));
    await tx
      .update(approvals)
      .set({ decidedBy: meta.actor, decidedAt: meta.now, decision, reason: meta.reason })
      .where(eq(approvals.batchId, batchId));
    await auditChange(tx, meta, {
      scope: 'approval',
      targetId: batchId,
      field: 'decision',
      before: 'pending',
      after: decision,
    });
    return { processId: b.processId, kind: b.kind };
  });
}

export async function closeRunByHand(
  ctx: Ctx,
  runId: string,
  status: SettledRunStatus,
  meta: ChangeMeta,
): Promise<void> {
  const run = await requireById(ctx.db, runs, runId, 'Run');
  if (isTerminalRunStatus(run.status)) {
    throw conflict(`run ${runId} is already ${run.status}`);
  }
  const closed = await closeRun(ctx, runId, {
    status,
    source: 'manual',
    reason: `closed by ${meta.actor}: ${meta.reason}`,
    inTx: (tx) =>
      auditChange(tx, meta, {
        scope: 'run',
        targetId: runId,
        field: 'status',
        before: run.status,
        after: status,
      }),
  });
  if (!closed) throw conflict(`run ${runId} closed concurrently`);
}

export async function resetBreaker(ctx: Ctx, processId: string, meta: ChangeMeta): Promise<void> {
  await withTx(ctx.db, async (tx) => {
    const p = await requireById(tx, processes, processId, 'Process', { forUpdate: true });
    await closeBreaker(tx, processId, meta.now);
    await auditChange(tx, meta, {
      scope: 'process',
      targetId: processId,
      field: 'breaker',
      before: p.breakerState,
      after: 'closed',
    });
  });
  ctx.telemetry.gauge('switchboard.breaker', 0, { process: processId });
}

export async function clearSoftHold(
  ctx: Ctx,
  destinationId: string,
  meta: ChangeMeta,
): Promise<void> {
  await withTx(ctx.db, async (tx) => {
    const e = await requireById(tx, destinations, destinationId, 'Destination', {
      forUpdate: true,
    });
    await tx
      .update(destinations)
      .set({ softHoldUntil: null, softHoldReason: null })
      .where(eq(destinations.id, destinationId));
    await auditChange(tx, meta, {
      scope: 'destination',
      targetId: destinationId,
      field: 'soft_hold_until',
      before: e.softHoldUntil?.toISOString() ?? null,
      after: null,
    });
  });
}

/** "Read now": audited once the reading is stored. */
export async function readMetersNow(
  ctx: Ctx,
  destinationId: string,
  meta: ChangeMeta,
): Promise<void> {
  await requireById(ctx.db, destinations, destinationId, 'Destination');
  if (!ctx.runtime.destination(destinationId)) {
    throw unavailable(`destination ${destinationId} has no live instance`);
  }
  await readMeters(ctx, destinationId, (tx) =>
    auditChange(tx, meta, { scope: 'destination', targetId: destinationId, field: 'meters_read' }),
  );
}
