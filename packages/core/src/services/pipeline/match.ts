import { and, eq, gt } from 'drizzle-orm';

import type { Event } from '@ai-switchboard/sdk';

import type { Tx } from '../../db/client.js';
import {
  batches,
  dispatches,
  events,
  processes,
  type MatchDecisionRecord,
} from '../../db/schema.js';
import { appendDecisions, lockKey, withTx } from '../../db/tx.js';
import type { DispatchOutcome } from '../../domain/status.js';
import {
  evaluateBatchKey,
  evaluateFilter,
  filterContext,
  type EvalFunctions,
  type KeyOutcome,
} from '../../expr/index.js';
import {
  closeCheck,
  joinBatch,
  type BatchingConfig,
  type OpenBatchState,
} from '../../pipeline/batch.js';
import { batchRecord } from '../../pipeline/decisions.js';
import { dedupe, dedupeWindowStart } from '../../pipeline/dedupe.js';
import { matchRecords } from '../../pipeline/match-records.js';
import {
  candidateTriggers,
  decideMatches,
  eventStageAfterMatch,
  skippedTriggers,
  type FilterEvaluation,
  type ProcessMatch,
} from '../../pipeline/match.js';

import type { Ctx } from './context.js';
import { evalFunctions } from './eval.js';
import { JOBS } from './jobs.js';
import { lockBatch } from './tx.js';
import { processView, toEvent, type BatchRow, type ProcessRow } from './views.js';

/**
 * Filters are evaluated outside the transaction because they may call `$resolve`; dedupe and
 * batch then run in one transaction per event.
 */

interface PendingJob {
  name: string;
  data: Record<string, unknown>;
  startAfter?: Date;
}

interface DispatchSignal {
  processId: string;
  outcome: string;
  batchId?: string;
}

interface Evaluated {
  matches: ProcessMatch[];
  keys: Map<string, KeyOutcome>;
  records: MatchDecisionRecord[];
}

/** A batch whose process is gone closes at once and is held at the gate. */
const CLOSE_AT_ONCE: BatchingConfig = { debounceSeconds: 0, maxSize: 1, maxAgeSeconds: 0 };

function openBatchState(row: BatchRow): OpenBatchState {
  return { id: row.id, openedAt: row.openedAt, fireAfter: row.fireAfter, size: row.size };
}

async function insertDispatch(
  tx: Tx,
  base: Omit<typeof dispatches.$inferInsert, 'outcome' | 'batchId'>,
  outcome: DispatchOutcome,
  batchId?: string,
): Promise<void> {
  await tx.insert(dispatches).values({ ...base, outcome, ...(batchId ? { batchId } : {}) });
}

export function matchEvent(ctx: Ctx, eventId: string): Promise<void> {
  return ctx.telemetry.span('switchboard.match', { event_id: eventId }, () =>
    matchEventInSpan(ctx, eventId),
  );
}

async function matchEventInSpan(ctx: Ctx, eventId: string): Promise<void> {
  const [row] = await ctx.db.select().from(events).where(eq(events.id, eventId));
  if (row?.stage !== 'received') return;
  const event = toEvent(row);
  const now = ctx.clock.now();
  // A stable order keeps lock acquisition consistent across concurrent match jobs. Disabled
  // processes are read too, only so the event records why they did not take it.
  const procRows = await ctx.db.select().from(processes).orderBy(processes.id);
  const byId = new Map(procRows.map((p) => [p.id, p]));
  const evaluated = await evaluateTriggers(ctx, event, byId, now);
  const stored = await storeMatches(ctx, event, byId, evaluated, now);
  if (!stored) return;

  ctx.telemetry.decision(
    'switchboard.events',
    { source: event.sourceId, type: event.type, stage: eventStageAfterMatch(evaluated.matches) },
    { event_id: eventId },
  );
  for (const s of stored.signals) {
    ctx.telemetry.decision(
      'switchboard.dispatches',
      { process: s.processId, source: event.sourceId, outcome: s.outcome },
      { event_id: eventId, process_id: s.processId, batch_id: s.batchId },
    );
  }
  for (const j of stored.jobs) {
    await ctx.queue.send(j.name, j.data, j.startAfter ? { startAfter: j.startAfter } : {});
  }
}

/** Every candidate trigger's filter, then the batch key of each process that matched. */
async function evaluateTriggers(
  ctx: Ctx,
  event: Event,
  byId: ReadonlyMap<string, ProcessRow>,
  now: Date,
): Promise<Evaluated> {
  const matchable = [...byId.values()].map((p) => ({
    id: p.id,
    enabled: p.enabled,
    document: p.document,
  }));
  const fns: EvalFunctions = evalFunctions(ctx, [event], now);
  const evaluations: FilterEvaluation[] = [];
  for (const c of candidateTriggers(event, matchable)) {
    const proc = byId.get(c.processId);
    const out = await evaluateFilter(
      ctx.engine,
      c.filter,
      filterContext(event, proc ? processView(proc) : null, now),
      fns,
    );
    evaluations.push({
      ...c,
      result: out.result,
      ...(out.error !== undefined ? { error: out.error } : {}),
    });
  }
  const matches = decideMatches(evaluations);
  const keys = new Map<string, KeyOutcome>();
  for (const m of matches) {
    const proc = byId.get(m.processId);
    if (m.outcome !== 'matched' || !proc) continue;
    keys.set(
      m.processId,
      await evaluateBatchKey(
        ctx.engine,
        proc.document.batching.groupBy,
        filterContext(event, processView(proc), now),
        fns,
      ),
    );
  }
  const records = matchRecords(evaluations, keys, skippedTriggers(event, matchable), now);
  return { matches, keys, records };
}

/** Dedupe and batch every match in one transaction; `null` when another worker took the event. */
function storeMatches(
  ctx: Ctx,
  event: Event,
  byId: ReadonlyMap<string, ProcessRow>,
  { matches, keys, records }: Evaluated,
  now: Date,
): Promise<{ signals: DispatchSignal[]; jobs: PendingJob[] } | null> {
  return withTx(ctx.db, async (tx) => {
    const signals: DispatchSignal[] = [];
    const jobs: PendingJob[] = [];
    const [locked] = await tx.select().from(events).where(eq(events.id, event.id)).for('update');
    if (locked?.stage !== 'received') return null;
    for (const m of matches) {
      const proc = byId.get(m.processId);
      if (!proc) continue;
      if (m.outcome === 'filtered') {
        signals.push({ processId: m.processId, outcome: 'filtered' });
        continue;
      }
      const base = {
        eventId: event.id,
        processId: m.processId,
        triggerId: m.triggerId,
        dedupeKey: event.dedupeKey,
        filter: {
          ...(m.filter !== undefined ? { expr: m.filter } : {}),
          result: m.outcome === 'matched',
          ...(m.error !== undefined ? { error: m.error } : {}),
        },
        createdAt: now,
      };
      if (m.outcome === 'filter_error') {
        await insertDispatch(tx, base, 'filter_error');
        signals.push({ processId: m.processId, outcome: 'filter_error' });
        continue;
      }
      if (await isDuplicate(tx, m.processId, event.dedupeKey, now)) {
        await insertDispatch(tx, base, 'deduped');
        signals.push({ processId: m.processId, outcome: 'deduped' });
        continue;
      }
      const batchId = await joinOrOpen(tx, proc, keys.get(m.processId)?.key ?? '', now, jobs);
      await insertDispatch(tx, base, 'batched', batchId);
      signals.push({ processId: m.processId, outcome: 'batched', batchId });
    }
    await tx
      .update(events)
      .set({ stage: eventStageAfterMatch(matches), matchDecisions: records })
      .where(eq(events.id, event.id));
    return { signals, jobs };
  });
}

async function isDuplicate(
  tx: Tx,
  processId: string,
  dedupeKey: string,
  now: Date,
): Promise<boolean> {
  await lockKey(tx, `dedupe:${processId}:${dedupeKey}`);
  const prior = await tx
    .select({ id: dispatches.id, createdAt: dispatches.createdAt })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.processId, processId),
        eq(dispatches.dedupeKey, dedupeKey),
        eq(dispatches.outcome, 'batched'),
        gt(dispatches.createdAt, dedupeWindowStart(now)),
      ),
    );
  return dedupe(prior, now).outcome === 'deduped';
}

async function joinOrOpen(
  tx: Tx,
  proc: ProcessRow,
  batchKey: string,
  now: Date,
  jobs: PendingJob[],
): Promise<string> {
  const config = proc.document.batching;
  const [open] = await tx
    .select()
    .from(batches)
    .where(
      and(
        eq(batches.processId, proc.id),
        eq(batches.batchKey, batchKey),
        eq(batches.kind, 'event'),
        eq(batches.outcome, 'open'),
      ),
    )
    .for('update');
  const decision = joinBatch(open ? openBatchState(open) : null, config, now);
  const closeReason = decision.closeNow;
  if (open) {
    await tx
      .update(batches)
      .set({
        size: decision.size,
        fireAfter: closeReason !== null ? now : decision.fireAfter,
        ...(closeReason !== null
          ? {
              outcome: 'closed' as const,
              closedAt: now,
              decisions: appendDecisions([batchRecord('close', now, closeReason)]),
            }
          : {}),
      })
      .where(eq(batches.id, open.id));
    if (closeReason !== null) jobs.push({ name: JOBS.dispatch, data: { batchId: open.id } });
    return open.id;
  }
  const decisions = [batchRecord('open', now, batchKey !== '' ? `key ${batchKey}` : undefined)];
  if (closeReason !== null) decisions.push(batchRecord('close', now, closeReason));
  // A racing replica may open the same (process, key) batch: the partial unique index rejects
  // the second insert and `withTx` retries, which then joins the winner's batch.
  const [created] = await tx
    .insert(batches)
    .values({
      processId: proc.id,
      batchKey,
      kind: 'event',
      openedAt: now,
      fireAfter: closeReason !== null ? now : decision.fireAfter,
      closedAt: closeReason !== null ? now : null,
      size: 1,
      outcome: closeReason !== null ? 'closed' : 'open',
      decisions,
    })
    .returning({ id: batches.id });
  if (!created) throw new Error('batch insert returned no row');
  jobs.push(
    closeReason !== null
      ? { name: JOBS.dispatch, data: { batchId: created.id } }
      : { name: JOBS.fire, data: { batchId: created.id }, startAfter: decision.fireAfter },
  );
  return created.id;
}

export function fireBatch(ctx: Ctx, batchId: string): Promise<void> {
  return ctx.telemetry.span('switchboard.batch', { batch_id: batchId }, () =>
    fireBatchInSpan(ctx, batchId),
  );
}

async function fireBatchInSpan(ctx: Ctx, batchId: string): Promise<void> {
  const now = ctx.clock.now();
  const out = await withTx(ctx.db, async (tx) => {
    const b = await lockBatch(tx, batchId);
    if (b?.outcome !== 'open') return null;
    const [proc] = await tx.select().from(processes).where(eq(processes.id, b.processId));
    const check = closeCheck(openBatchState(b), proc?.document.batching ?? CLOSE_AT_ONCE, now);
    if (!check.close) return { later: check.checkAt };
    await tx
      .update(batches)
      .set({
        outcome: 'closed',
        closedAt: now,
        decisions: appendDecisions([batchRecord('close', now, check.reason)]),
      })
      .where(eq(batches.id, batchId));
    return { later: null };
  });
  if (!out) return;
  if (out.later) {
    await ctx.queue.send(JOBS.fire, { batchId }, { startAfter: out.later });
  } else {
    await ctx.queue.send(JOBS.dispatch, { batchId });
  }
}
