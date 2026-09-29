import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import type { Event } from '@ai-switchboard/sdk';

import type { Tx } from '../../db/client.js';
import {
  approvals,
  batches,
  destinations,
  events as eventsTable,
  processes,
  runs,
  sources,
  type GateDecisionRecord,
} from '../../db/schema.js';
import type { HoldReason } from '../../domain/status.js';
import {
  evaluateFilter,
  evaluateMapping,
  mappingContext,
  type RunContext,
} from '../../expr/index.js';
import { budget, type BudgetResult } from '../../pipeline/budget.js';
import { gate } from '../../pipeline/gate.js';
import { trackingDeadline } from '../../pipeline/tracking.js';
import type { LiveDestination } from '../../plugins/runtime.js';
import type { SpanHandle } from '../../telemetry/telemetry.js';
import { getSettings } from '../settings.js';

import {
  JOBS,
  appendDecisions,
  evalFunctions,
  lockKey,
  processView,
  withTx,
  type Ctx,
  type ProcessRow,
} from './context.js';
import { countersFor } from './counters.js';
import { attemptInvoke } from './invoke.js';
import { batchEvents, type BatchRow } from './load.js';
import { meterSnapshots } from './meters.js';
import { notifyProcess } from './notify.js';

/**
 * Gate, input mapping, then budget check and reservation in one transaction (the `invoking` run
 * row is the reservation), then the first invoke attempt.
 */

export interface DispatchResult {
  batchId: string;
  runId: string | null;
  /** The batch outcome (`held`, `throttled`, `awaiting_approval`, …) or the run status. */
  outcome: string;
}

function modeFor(batch: BatchRow, events: readonly Event[]): 'event' | 'sweep' {
  if (batch.kind === 'event') return 'event';
  if (batch.kind === 'sweep') return 'sweep';
  return events.length > 0 ? 'event' : 'sweep';
}

async function existingRun(ctx: Ctx, batchId: string) {
  const [run] = await ctx.db.select().from(runs).where(eq(runs.batchId, batchId));
  return run;
}

/** The dispatch span links to the ingest span of every event in the batch. */
export function dispatchBatch(ctx: Ctx, batchId: string): Promise<DispatchResult> {
  return ctx.telemetry.span('switchboard.dispatch', { batch_id: batchId }, async (span) => {
    const out = await dispatchBatchInSpan(ctx, batchId, span);
    span.setAttributes({ run_id: out.runId ?? undefined, 'switchboard.outcome': out.outcome });
    return out;
  });
}

async function eventTraceContexts(ctx: Ctx, eventIds: string[]): Promise<(string | null)[]> {
  if (eventIds.length === 0) return [];
  const rows = await ctx.db
    .select({ traceContext: eventsTable.traceContext })
    .from(eventsTable)
    .where(inArray(eventsTable.id, eventIds));
  return rows.map((r) => r.traceContext);
}

async function dispatchBatchInSpan(
  ctx: Ctx,
  batchId: string,
  span: SpanHandle,
): Promise<DispatchResult> {
  const [batch] = await ctx.db.select().from(batches).where(eq(batches.id, batchId));
  if (!batch) return { batchId, runId: null, outcome: 'missing' };
  if (batch.outcome !== 'closed') {
    const run = await existingRun(ctx, batchId);
    return { batchId, runId: run?.id ?? null, outcome: run?.status ?? batch.outcome };
  }
  const now = ctx.clock.now();
  const at = now.toISOString();
  const [proc] = await ctx.db.select().from(processes).where(eq(processes.id, batch.processId));
  if (!proc) {
    await hold(ctx, batch, null, 'process_disabled', 'process deleted', [], []);
    return { batchId, runId: null, outcome: 'held' };
  }
  const doc = proc.document;
  const settings = await getSettings(ctx.db);
  const events = await batchEvents(ctx.db, batch);
  span.addLinks(
    await eventTraceContexts(
      ctx,
      events.map((e) => e.id),
    ),
  );
  span.setAttributes({
    process_id: proc.id,
    'switchboard.batch.kind': batch.kind,
    'switchboard.batch.size': events.length,
  });
  // The run's trace: tracking, callbacks and recovery continue or link to this span.
  const runTrace = ctx.telemetry.traceparent() ?? null;
  const mode = modeFor(batch, events);
  const destinationId = doc.destination.instanceId;
  const [exRow] = await ctx.db
    .select()
    .from(destinations)
    .where(eq(destinations.id, destinationId));
  const live = ctx.runtime.destination(destinationId);
  const sourceIds = [...new Set(events.map((e) => e.sourceId))];
  const sourceRows =
    sourceIds.length > 0
      ? await ctx.db
          .select({ id: sources.id, enabled: sources.enabled })
          .from(sources)
          .where(inArray(sources.id, sourceIds))
      : [];
  const runId = randomUUID();
  const run: RunContext = {
    id: runId,
    dryRun: batch.dryRun,
    mode: batch.kind === 'manual' ? 'manual' : mode,
    processId: proc.id,
    processName: proc.name,
    callbackUrl: `${ctx.config.publicUrl}/callbacks/${destinationId}`,
    deadline: trackingDeadline(now, doc.trackingDeadlineMinutes).toISOString(),
  };
  const fallbackSources = doc.triggers.map((t) => t.sourceId);
  const fns = evalFunctions(ctx, events, now, fallbackSources);
  const mctx = mappingContext({ events, process: processView(proc), run, mode });

  const g = await ctx.telemetry.span(
    'switchboard.gate',
    { batch_id: batchId, process_id: proc.id },
    async (gateSpan) => {
      const rule = doc.gates.approval;
      let required = rule === 'always';
      let approvalError: string | undefined;
      if (
        rule !== 'none' &&
        rule !== 'always' &&
        !batch.dryRun &&
        batch.approvalState !== 'approved'
      ) {
        const out = await evaluateFilter(
          ctx.engine,
          rule,
          { ...mctx, batch: { id: batch.id, kind: batch.kind, size: events.length } },
          fns,
        );
        // An approval expression that fails asks a person (fail closed).
        required = out.result || out.error !== undefined;
        approvalError = out.error;
      }

      const result = gate(
        {
          kind: batch.kind,
          dryRun: batch.dryRun,
          process: { enabled: proc.enabled },
          sources: sourceIds.map((id) => ({
            id,
            enabled: sourceRows.find((s) => s.id === id)?.enabled ?? false,
          })),
          destination: {
            exists: exRow !== undefined,
            enabled: exRow?.enabled ?? false,
            pluginAvailable: exRow
              ? ctx.runtime.destinationType(exRow.typeId) !== undefined
              : false,
            live: live !== undefined,
            instanceError: ctx.runtime.instanceError(destinationId),
            health: exRow?.health ?? null,
          },
          breaker: {
            state: proc.breakerState,
            openedAt: proc.breakerOpenedAt,
            cooldownMinutes: doc.gates.breaker.cooldownMinutes,
          },
          quietHours: doc.gates.quietHours ?? settings.defaultQuietHours,
          defaultTimezone: settings.timezone,
          approval: {
            rule,
            required,
            state: batch.approvalState,
            ...(approvalError !== undefined ? { error: approvalError } : {}),
          },
        },
        now,
      );
      gateSpan.setAttributes({
        'switchboard.gate.pass': result.pass,
        'switchboard.gate.reason': result.pass ? undefined : result.reason,
      });
      return result;
    },
  );
  if (g.breakerClosed && proc.breakerOpenedAt) {
    // Only the opening this gate saw: a breaker reset and re-opened meanwhile stays open.
    const closed = await ctx.db
      .update(processes)
      .set({ breakerState: 'closed', breakerOpenedAt: null, breakerResetAt: now })
      .where(
        and(
          eq(processes.id, proc.id),
          eq(processes.breakerState, 'open'),
          eq(processes.breakerOpenedAt, proc.breakerOpenedAt),
        ),
      )
      .returning({ id: processes.id });
    if (closed.length > 0) ctx.telemetry.gauge('switchboard.breaker', 0, { process: proc.id });
  }
  const gateRecords: GateDecisionRecord[] = g.checks.map((c) => ({
    stage: 'gate',
    check: c.check,
    pass: c.pass,
    ...(c.detail !== undefined ? { detail: c.detail } : {}),
    at,
  }));
  if (!g.pass) {
    let preview: unknown = null;
    if (g.reason === 'awaiting_approval') {
      const m = await evaluateMapping(ctx.engine, doc.input, mctx, fns, live?.type.inputSchema);
      preview = m.ok ? m.input : (m.input ?? { errors: m.errors });
    }
    await hold(ctx, batch, proc, g.reason, g.detail ?? null, gateRecords, events, preview);
    return {
      batchId,
      runId: null,
      outcome: g.reason === 'awaiting_approval' ? 'awaiting_approval' : 'held',
    };
  }
  if (!live || !exRow) {
    // The gate guarantees both; this keeps the types honest.
    await hold(ctx, batch, proc, 'destination_unhealthy', 'no live instance', gateRecords, events);
    return { batchId, runId: null, outcome: 'held' };
  }

  // Input mapping, validated before any budget is spent.
  const mapping = await evaluateMapping(ctx.engine, doc.input, mctx, fns, live.type.inputSchema);
  if (!mapping.ok) {
    const record: GateDecisionRecord = {
      stage: 'budget',
      check: 'input',
      pass: false,
      detail: `input_invalid: ${mapping.errors.join('; ')}`.slice(0, 1000),
      at,
    };
    const created = await withTx(ctx.db, async (tx) => {
      const [b] = await tx.select().from(batches).where(eq(batches.id, batchId)).for('update');
      if (b?.outcome !== 'closed') return false;
      await tx.insert(runs).values({
        id: runId,
        batchId,
        processId: proc.id,
        processVersion: proc.version,
        destinationId,
        kind: batch.kind,
        status: 'failed',
        statusReason: 'input_invalid',
        input: mapping.input ?? null,
        errors: mapping.errors,
        dryRun: batch.dryRun,
        attempts: 0,
        finishedAt: now,
        firstEventAt: firstEventAt(events),
        traceContext: runTrace,
        createdAt: now,
      });
      await tx
        .update(batches)
        .set({
          outcome: 'invoked',
          outcomeReason: 'input_invalid',
          decisions: appendDecisions([...gateRecords, record]),
        })
        .where(eq(batches.id, batchId));
      return true;
    });
    if (created) {
      signalBatch(ctx, proc.id, batch, 'invoked', 'input_invalid', runId);
      ctx.telemetry.decision(
        'switchboard.runs',
        { process: proc.id, destination: destinationId, status: 'failed' },
        { process_id: proc.id, batch_id: batchId, run_id: runId },
      );
      await ctx.queue.send(JOBS.finish, { runId });
    }
    return { batchId, runId: created ? runId : null, outcome: 'failed' };
  }

  // Budget check and reservation in one transaction, serialised per destination.
  const reserve = () =>
    withTx(ctx.db, async (tx) => {
      await lockKey(tx, `destination:${destinationId}`);
      const [b] = await tx.select().from(batches).where(eq(batches.id, batchId)).for('update');
      if (b?.outcome !== 'closed') return { outcome: 'gone' as const, result: null };
      const checked = batch.dryRun
        ? { result: null, record: dryRunBudgetRecord(at) }
        : await checkBudget(tx, {
            kind: batch.kind,
            budgets: doc.budgets,
            processId: proc.id,
            destinationId,
            live,
            defaultStalenessMinutes: settings.meterStalenessMinutes,
            now,
          });
      const records = [...gateRecords, checked.record];
      if (checked.result && !checked.result.ok) {
        await tx
          .update(batches)
          .set({
            outcome: 'throttled',
            outcomeReason: checked.result.binding,
            decisions: appendDecisions(records),
          })
          .where(eq(batches.id, batchId));
        return { outcome: 'throttled' as const, result: checked.result };
      }
      await tx.insert(runs).values({
        id: runId,
        batchId,
        processId: proc.id,
        processVersion: proc.version,
        destinationId,
        kind: batch.kind,
        status: 'invoking',
        input: mapping.input,
        dryRun: batch.dryRun,
        attempts: 0,
        invokedAt: now,
        deadlineAt: trackingDeadline(now, doc.trackingDeadlineMinutes),
        firstEventAt: firstEventAt(events),
        traceContext: runTrace,
        createdAt: now,
      });
      await tx
        .update(batches)
        .set({ outcome: 'invoked', outcomeReason: null, decisions: appendDecisions(records) })
        .where(eq(batches.id, batchId));
      return { outcome: 'reserved' as const, result: checked.result };
    });
  const reservation = await ctx.telemetry.span(
    'switchboard.budget',
    { batch_id: batchId, process_id: proc.id, destination_id: destinationId },
    async (budgetSpan) => {
      const out = await reserve();
      budgetSpan.setAttributes({
        'switchboard.budget.outcome': out.outcome,
        'switchboard.budget.binding': out.result?.binding ?? undefined,
      });
      return out;
    },
  );
  const budgetResult = reservation.result;
  if (budgetResult) emitBudgetGauges(ctx, proc, budgetResult);
  if (reservation.outcome === 'gone') {
    const existing = await existingRun(ctx, batchId);
    const [b] = await ctx.db.select().from(batches).where(eq(batches.id, batchId));
    return {
      batchId,
      runId: existing?.id ?? null,
      outcome: existing?.status ?? b?.outcome ?? 'missing',
    };
  }
  if (reservation.outcome === 'throttled') {
    signalBatch(ctx, proc.id, batch, 'throttled', budgetResult?.binding ?? '', null);
    await notifyProcess(ctx, {
      process: proc,
      on: 'throttled',
      batchId,
      events,
      context: {
        batch: { id: batchId, kind: batch.kind },
        reason: budgetResult?.detail ?? budgetResult?.binding ?? 'throttled',
        bindingLimit: budgetResult?.binding ?? null,
      },
    });
    return { batchId, runId: null, outcome: 'throttled' };
  }

  signalBatch(ctx, proc.id, batch, 'invoked', '', runId);
  const first = firstEventAt(events);
  if (first)
    ctx.telemetry.histogram('switchboard.run.latency', (now.getTime() - first.getTime()) / 1000, {
      process: proc.id,
    });
  if (batch.kind === 'sweep' && batch.tickAt) {
    ctx.telemetry.histogram(
      'switchboard.schedule.lag',
      (now.getTime() - batch.tickAt.getTime()) / 1000,
      { process: proc.id },
    );
  }

  // `before` steps run inside the first invoke attempt, under its claim.
  await attemptInvoke(ctx, runId);
  const [final] = await ctx.db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
  return { batchId, runId, outcome: final?.status ?? 'invoking' };
}

async function checkBudget(
  tx: Tx,
  input: {
    kind: BatchRow['kind'];
    budgets: ProcessRow['document']['budgets'];
    processId: string;
    destinationId: string;
    live: LiveDestination;
    defaultStalenessMinutes: number;
    now: Date;
  },
): Promise<{ result: BudgetResult; record: GateDecisionRecord }> {
  const { destinationId, live, now } = input;
  const [ex] = await tx.select().from(destinations).where(eq(destinations.id, destinationId));
  const caps = ex?.caps ?? {};
  const counters = await countersFor(
    tx,
    { processId: input.processId, destinationId, dimensions: live.usage },
    now,
  );
  const meters = await meterSnapshots(tx, destinationId, live.meters, caps, now);
  const result = budget(
    {
      kind: input.kind,
      process: {
        runsPerHour: input.budgets.runsPerHour,
        runsPerDay: input.budgets.runsPerDay,
        usagePerDay: input.budgets.usagePerDay,
        meterCeilings: input.budgets.meterCeilings,
      },
      destination: {
        runsPerHour: caps.runsPerHour,
        runsPerDay: caps.runsPerDay,
        usagePerDay: caps.usagePerDay,
        softHoldUntil: ex?.softHoldUntil ?? null,
        stalenessMinutes: caps.meterStalenessMinutes ?? input.defaultStalenessMinutes,
      },
      counters,
      dimensions: live.usage,
      meters,
    },
    now,
  );
  const record: GateDecisionRecord = {
    stage: 'budget',
    check: 'budget',
    pass: result.ok,
    ...(result.detail !== null ? { detail: result.detail } : {}),
    at: now.toISOString(),
    data: {
      binding: result.binding,
      checks: result.checks,
      counters,
      meters: Object.fromEntries(
        Object.entries(meters).map(([id, m]) => [
          id,
          {
            utilization: m.utilization,
            observedAt: m.observedAt.toISOString(),
            estimated: m.estimated,
            resetsAt: m.resetsAt?.toISOString() ?? null,
          },
        ]),
      ),
      meterStale: result.meterStale,
    },
  };
  return { result, record };
}

function dryRunBudgetRecord(at: string): GateDecisionRecord {
  return { stage: 'budget', check: 'budget', pass: true, detail: 'dry run: not counted', at };
}

function firstEventAt(events: readonly Event[]): Date | null {
  let min: number | null = null;
  for (const e of events) {
    const t = Date.parse(e.occurredAt);
    if (!Number.isNaN(t) && (min === null || t < min)) min = t;
  }
  return min === null ? null : new Date(min);
}

function signalBatch(
  ctx: Ctx,
  processId: string,
  batch: BatchRow,
  outcome: string,
  reason: string,
  runId: string | null,
): void {
  ctx.telemetry.decision(
    'switchboard.batches',
    { process: processId, kind: batch.kind, outcome, reason },
    { process_id: processId, batch_id: batch.id, run_id: runId ?? undefined },
  );
}

function emitBudgetGauges(ctx: Ctx, proc: ProcessRow, result: BudgetResult): void {
  for (const c of result.checks) {
    if (c.used === undefined || c.limit === undefined) continue;
    const window = c.check.includes('hour')
      ? 'hour'
      : c.check.startsWith('meter:')
        ? 'meter'
        : 'day';
    ctx.telemetry.gauge('switchboard.budget.used', c.used, {
      scope: `${proc.id}:${c.check}`,
      window,
    });
  }
}

async function hold(
  ctx: Ctx,
  batch: BatchRow,
  proc: ProcessRow | null,
  reason: HoldReason,
  detail: string | null,
  records: GateDecisionRecord[],
  events: readonly Event[],
  preview: unknown = null,
): Promise<void> {
  const now = ctx.clock.now();
  const awaiting = reason === 'awaiting_approval';
  const moved = await withTx(ctx.db, async (tx) => {
    const [b] = await tx.select().from(batches).where(eq(batches.id, batch.id)).for('update');
    if (b?.outcome !== 'closed') return false;
    await tx
      .update(batches)
      .set({
        outcome: awaiting ? 'awaiting_approval' : 'held',
        outcomeReason: reason,
        ...(awaiting ? { approvalState: 'pending' as const } : {}),
        decisions: appendDecisions(records),
      })
      .where(eq(batches.id, batch.id));
    if (awaiting && proc) {
      await tx
        .insert(approvals)
        .values({
          batchId: batch.id,
          processId: proc.id,
          rule: proc.document.gates.approval,
          input: preview ?? null,
          requestedAt: now,
        })
        .onConflictDoNothing();
    }
    return true;
  });
  if (!moved) return;
  signalBatch(ctx, batch.processId, batch, awaiting ? 'awaiting_approval' : 'held', reason, null);
  if (proc) {
    await notifyProcess(ctx, {
      process: proc,
      on: 'held',
      batchId: batch.id,
      events,
      context: {
        batch: { id: batch.id, kind: batch.kind },
        reason: detail ? `${reason}: ${detail}` : reason,
      },
    });
  }
}
