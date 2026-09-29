import { and, eq, gt } from 'drizzle-orm';

import type { Tx } from '../../db/client.js';
import {
  batches,
  dispatches,
  events,
  processes,
  type GateDecisionRecord,
  type MatchDecisionRecord,
} from '../../db/schema.js';
import { evaluateBatchKey, evaluateFilter, filterContext } from '../../expr/index.js';
import { closeCheck, joinBatch, type BatchingConfig } from '../../pipeline/batch.js';
import { dedupe, dedupeWindowStart } from '../../pipeline/dedupe.js';
import {
  candidateTriggers,
  decideMatches,
  eventStageAfterMatch,
  skippedTriggers,
  type FilterEvaluation,
} from '../../pipeline/match.js';

import {
  JOBS,
  appendDecisions,
  evalFunctions,
  lockKey,
  processView,
  toEvent,
  withTx,
  type Ctx,
  type ProcessRow,
} from './context.js';

/**
 * Filters are evaluated outside the transaction because they may call `$resolve`; dedupe and
 * batch then run in one transaction per event.
 */

interface PendingJob {
  name: string;
  data: Record<string, unknown>;
  startAfter?: Date;
}

export function batchingOf(row: ProcessRow): BatchingConfig {
  const b = row.document.batching;
  return { debounceSeconds: b.debounceSeconds, maxSize: b.maxSize, maxAgeSeconds: b.maxAgeSeconds };
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
  const matchable = procRows.map((p) => ({ id: p.id, enabled: p.enabled, document: p.document }));
  const candidates = candidateTriggers(event, matchable);
  const skipped = skippedTriggers(event, matchable);
  const fns = evalFunctions(ctx, [event], now);

  const evaluations: FilterEvaluation[] = [];
  for (const c of candidates) {
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
  const keys = new Map<string, { key: string; error?: string }>();
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
  const records: MatchDecisionRecord[] = evaluations.map((e) => {
    const key = e.result ? keys.get(e.processId) : undefined;
    return {
      processId: e.processId,
      triggerId: e.triggerId,
      ...(e.filter !== undefined ? { expr: e.filter } : {}),
      result: e.result,
      ...(e.error !== undefined
        ? { error: e.error }
        : key?.error !== undefined
          ? { error: `groupBy: ${key.error}` }
          : {}),
      ...(key ? { batchKey: key.key } : {}),
      at: now.toISOString(),
    };
  });
  for (const k of skipped) {
    records.push({
      processId: k.processId,
      triggerId: k.triggerId,
      result: false,
      skip: k.skip,
      at: now.toISOString(),
    });
  }

  const signals: { processId: string; outcome: string; batchId?: string }[] = [];
  const jobs: PendingJob[] = [];
  const done = await withTx(ctx.db, async (tx) => {
    signals.length = 0;
    jobs.length = 0;
    const [locked] = await tx.select().from(events).where(eq(events.id, eventId)).for('update');
    if (locked?.stage !== 'received') return false;
    for (const m of matches) {
      const proc = byId.get(m.processId);
      if (!proc) continue;
      const filter = {
        ...(m.filter !== undefined ? { expr: m.filter } : {}),
        result: m.outcome === 'matched',
        ...(m.error !== undefined ? { error: m.error } : {}),
      };
      if (m.outcome === 'filtered') {
        signals.push({ processId: m.processId, outcome: 'filtered' });
        continue;
      }
      if (m.outcome === 'filter_error') {
        await tx.insert(dispatches).values({
          eventId,
          processId: m.processId,
          triggerId: m.triggerId,
          dedupeKey: event.dedupeKey,
          outcome: 'filter_error',
          filter,
          createdAt: now,
        });
        signals.push({ processId: m.processId, outcome: 'filter_error' });
        continue;
      }
      await lockKey(tx, `dedupe:${m.processId}:${event.dedupeKey}`);
      const prior = await tx
        .select({ id: dispatches.id, createdAt: dispatches.createdAt })
        .from(dispatches)
        .where(
          and(
            eq(dispatches.processId, m.processId),
            eq(dispatches.dedupeKey, event.dedupeKey),
            eq(dispatches.outcome, 'batched'),
            gt(dispatches.createdAt, dedupeWindowStart(now)),
          ),
        );
      const dd = dedupe(prior, now);
      if (dd.outcome === 'deduped') {
        await tx.insert(dispatches).values({
          eventId,
          processId: m.processId,
          triggerId: m.triggerId,
          dedupeKey: event.dedupeKey,
          outcome: 'deduped',
          filter,
          createdAt: now,
        });
        signals.push({ processId: m.processId, outcome: 'deduped' });
        continue;
      }
      const batchKey = keys.get(m.processId)?.key ?? '';
      const batchId = await joinOrOpen(tx, proc, batchKey, now, jobs);
      await tx.insert(dispatches).values({
        eventId,
        processId: m.processId,
        triggerId: m.triggerId,
        dedupeKey: event.dedupeKey,
        outcome: 'batched',
        filter,
        batchId,
        createdAt: now,
      });
      signals.push({ processId: m.processId, outcome: 'batched', batchId });
    }
    await tx
      .update(events)
      .set({ stage: eventStageAfterMatch(matches), matchDecisions: records })
      .where(eq(events.id, eventId));
    return true;
  });
  if (!done) return;

  ctx.telemetry.decision(
    'switchboard.events',
    { source: event.sourceId, type: event.type, stage: eventStageAfterMatch(matches) },
    { event_id: eventId },
  );
  for (const s of signals) {
    ctx.telemetry.decision(
      'switchboard.dispatches',
      { process: s.processId, source: event.sourceId, outcome: s.outcome },
      { event_id: eventId, process_id: s.processId, batch_id: s.batchId },
    );
  }
  for (const j of jobs) {
    await ctx.queue.send(j.name, j.data, j.startAfter ? { startAfter: j.startAfter } : {});
  }
}

async function joinOrOpen(
  tx: Tx,
  proc: ProcessRow,
  batchKey: string,
  now: Date,
  jobs: PendingJob[],
): Promise<string> {
  const config = batchingOf(proc);
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
  const at = now.toISOString();
  const decision = joinBatch(
    open
      ? { id: open.id, openedAt: open.openedAt, fireAfter: open.fireAfter, size: open.size }
      : null,
    config,
    now,
  );
  const closeRecord = (reason: string): GateDecisionRecord => ({
    stage: 'batch',
    check: 'close',
    pass: true,
    detail: reason,
    at,
  });
  if (open) {
    const closing = decision.closeNow !== null;
    await tx
      .update(batches)
      .set({
        size: decision.size,
        fireAfter: closing ? now : decision.fireAfter,
        ...(closing
          ? {
              outcome: 'closed' as const,
              closedAt: now,
              decisions: appendDecisions([closeRecord(decision.closeNow ?? '')]),
            }
          : {}),
      })
      .where(eq(batches.id, open.id));
    if (closing) jobs.push({ name: JOBS.dispatch, data: { batchId: open.id } });
    return open.id;
  }
  const closing = decision.closeNow !== null;
  const decisions: GateDecisionRecord[] = [
    {
      stage: 'batch',
      check: 'open',
      pass: true,
      ...(batchKey !== '' ? { detail: `key ${batchKey}` } : {}),
      at,
    },
  ];
  if (closing) decisions.push(closeRecord(decision.closeNow ?? ''));
  // A racing replica may open the same (process, key) batch: the partial unique index rejects
  // the second insert and `withTx` retries, which then joins the winner's batch.
  const [created] = await tx
    .insert(batches)
    .values({
      processId: proc.id,
      batchKey,
      kind: 'event',
      openedAt: now,
      fireAfter: closing ? now : decision.fireAfter,
      closedAt: closing ? now : null,
      size: 1,
      outcome: closing ? 'closed' : 'open',
      decisions,
    })
    .returning({ id: batches.id });
  if (!created) throw new Error('batch insert returned no row');
  jobs.push(
    closing
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
    const [b] = await tx.select().from(batches).where(eq(batches.id, batchId)).for('update');
    if (b?.outcome !== 'open') return null;
    const [proc] = await tx.select().from(processes).where(eq(processes.id, b.processId));
    const config = proc ? batchingOf(proc) : { debounceSeconds: 0, maxSize: 1, maxAgeSeconds: 0 };
    const check = closeCheck(
      { id: b.id, openedAt: b.openedAt, fireAfter: b.fireAfter, size: b.size },
      config,
      now,
    );
    if (!check.close) return { later: check.checkAt };
    const record: GateDecisionRecord = {
      stage: 'batch',
      check: 'close',
      pass: true,
      detail: check.reason,
      at: now.toISOString(),
    };
    await tx
      .update(batches)
      .set({
        outcome: 'closed',
        closedAt: now,
        decisions: appendDecisions([record]),
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
