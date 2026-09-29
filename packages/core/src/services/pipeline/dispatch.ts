import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';

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
  approvalContext,
  evaluateFilter,
  evaluateMapping,
  mappingContext,
  type EvalFunctions,
  type MappingOutcome,
  type RunContext,
} from '../../expr/index.js';
import { budget, type BudgetResult } from '../../pipeline/budget.js';
import {
  approvalNeedsEvaluation,
  approvalRequired,
  gate,
  type GateCheck,
  type GateInput,
  type GateResult,
} from '../../pipeline/gate.js';
import { runMode, type MappingMode } from '../../pipeline/run-mode.js';
import { trackingDeadline } from '../../pipeline/tracking.js';
import type { LiveDestination } from '../../plugins/runtime.js';
import type { SpanHandle } from '../../telemetry/telemetry.js';
import { getSettings } from '../settings.js';

import { closeBreaker } from './breaker.js';
import type { Ctx } from './context.js';
import { countersFor } from './counters.js';
import { evalFunctions } from './eval.js';
import { attemptInvoke } from './invoke.js';
import { JOBS } from './jobs.js';
import { batchEvents } from './load.js';
import { meterSnapshots } from './meters.js';
import { notifyProcess } from './notify.js';
import { appendDecisions, lockClosedBatch, lockKey, withTx } from './tx.js';
import { processView, type BatchRow, type ProcessRow } from './views.js';

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

type Settings = Awaited<ReturnType<typeof getSettings>>;
type DestinationRow = typeof destinations.$inferSelect;

interface Dispatch {
  batch: BatchRow;
  proc: ProcessRow;
  now: Date;
  at: string;
  settings: Settings;
  events: Event[];
  destinationId: string;
  destinationRow: DestinationRow | undefined;
  live: LiveDestination | undefined;
  sources: { id: string; enabled: boolean }[];
  runId: string;
  runTrace: string | null;
  fns: EvalFunctions;
  mapping: Record<string, unknown>;
}

/** The dispatch span links to the ingest span of every event in the batch. */
export function dispatchBatch(ctx: Ctx, batchId: string): Promise<DispatchResult> {
  return ctx.telemetry.span('switchboard.dispatch', { batch_id: batchId }, async (span) => {
    const out = await dispatchBatchInSpan(ctx, batchId, span);
    span.setAttributes({ run_id: out.runId ?? undefined, 'switchboard.outcome': out.outcome });
    return out;
  });
}

async function dispatchBatchInSpan(
  ctx: Ctx,
  batchId: string,
  span: SpanHandle,
): Promise<DispatchResult> {
  const [batch] = await ctx.db.select().from(batches).where(eq(batches.id, batchId));
  if (!batch) return { batchId, runId: null, outcome: 'missing' };
  if (batch.outcome !== 'closed') return currentOutcome(ctx, batchId);
  const now = ctx.clock.now();
  const [proc] = await ctx.db.select().from(processes).where(eq(processes.id, batch.processId));
  if (!proc) {
    await hold(ctx, batch, null, now, { reason: 'process_disabled', detail: 'process deleted' });
    return { batchId, runId: null, outcome: 'held' };
  }
  const d = await prepare(ctx, batch, proc, now, span);

  const g = await gateStep(ctx, d);
  if (g.breakerClosed && proc.breakerOpenedAt) {
    if (await closeBreaker(ctx.db, proc.id, now, proc.breakerOpenedAt)) {
      ctx.telemetry.gauge('switchboard.breaker', 0, { process: proc.id });
    }
  }
  const gateRecords = g.checks.map((c) => gateRecord(c, d.at));
  if (!g.pass) {
    const awaiting = g.reason === 'awaiting_approval';
    const preview = awaiting ? approvalPreview(await mapInput(ctx, d)) : null;
    await hold(ctx, batch, proc, now, {
      reason: g.reason,
      detail: g.detail ?? null,
      records: gateRecords,
      events: d.events,
      preview,
    });
    return { batchId, runId: null, outcome: awaiting ? 'awaiting_approval' : 'held' };
  }
  const { live, destinationRow } = d;
  if (!live || !destinationRow) {
    await hold(ctx, batch, proc, now, {
      reason: 'destination_unhealthy',
      detail: 'no live instance',
      records: gateRecords,
      events: d.events,
    });
    return { batchId, runId: null, outcome: 'held' };
  }

  const mapped = await mapInput(ctx, d);
  if (!mapped.ok) return failInput(ctx, d, mapped, gateRecords);

  const reservation = await reserve(ctx, d, live, mapped.input, gateRecords);
  const budgetResult = reservation.result;
  if (budgetResult) emitBudgetGauges(ctx, proc, budgetResult);
  if (reservation.outcome === 'gone') return currentOutcome(ctx, batchId);
  if (reservation.outcome === 'throttled') {
    signalBatch(ctx, batch, 'throttled', budgetResult?.binding ?? '', null);
    await notifyProcess(ctx, {
      process: proc,
      on: 'throttled',
      batchId,
      events: d.events,
      context: {
        batch: { id: batchId, kind: batch.kind },
        reason: budgetResult?.detail ?? budgetResult?.binding ?? 'throttled',
        bindingLimit: budgetResult?.binding ?? null,
      },
    });
    return { batchId, runId: null, outcome: 'throttled' };
  }

  signalBatch(ctx, batch, 'invoked', '', d.runId);
  emitLatency(ctx, d);
  // `before` steps run inside the first invoke attempt, under its claim.
  await attemptInvoke(ctx, d.runId);
  const [final] = await ctx.db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, d.runId));
  return { batchId, runId: d.runId, outcome: final?.status ?? 'invoking' };
}

async function currentOutcome(ctx: Ctx, batchId: string): Promise<DispatchResult> {
  const [run] = await ctx.db.select().from(runs).where(eq(runs.batchId, batchId));
  const [b] = await ctx.db
    .select({ outcome: batches.outcome })
    .from(batches)
    .where(eq(batches.id, batchId));
  return { batchId, runId: run?.id ?? null, outcome: run?.status ?? b?.outcome ?? 'missing' };
}

async function eventTraceContexts(ctx: Ctx, eventIds: string[]): Promise<(string | null)[]> {
  if (eventIds.length === 0) return [];
  const rows = await ctx.db
    .select({ traceContext: eventsTable.traceContext })
    .from(eventsTable)
    .where(inArray(eventsTable.id, eventIds));
  return rows.map((r) => r.traceContext);
}

async function prepare(
  ctx: Ctx,
  batch: BatchRow,
  proc: ProcessRow,
  now: Date,
  span: SpanHandle,
): Promise<Dispatch> {
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
  const destinationId = doc.destination.instanceId;
  const [destinationRow] = await ctx.db
    .select()
    .from(destinations)
    .where(eq(destinations.id, destinationId));
  const sourceIds = [...new Set(events.map((e) => e.sourceId))];
  const sourceRows =
    sourceIds.length > 0
      ? await ctx.db
          .select({ id: sources.id, enabled: sources.enabled })
          .from(sources)
          .where(inArray(sources.id, sourceIds))
      : [];
  const enabled = new Map(sourceRows.map((s) => [s.id, s.enabled]));
  const runId = randomUUID();
  const mode: MappingMode = runMode(batch.kind, events.length);
  const run: RunContext = {
    id: runId,
    dryRun: batch.dryRun,
    mode: batch.kind,
    processId: proc.id,
    processName: proc.name,
    callbackUrl: `${ctx.config.publicUrl}/callbacks/${destinationId}`,
    deadline: trackingDeadline(now, doc.trackingDeadlineMinutes).toISOString(),
  };
  return {
    batch,
    proc,
    now,
    at: now.toISOString(),
    settings,
    events,
    destinationId,
    destinationRow,
    live: ctx.runtime.destination(destinationId),
    sources: sourceIds.map((id) => ({ id, enabled: enabled.get(id) ?? false })),
    runId,
    // The run's trace: tracking, callbacks and recovery continue or link to this span.
    runTrace: ctx.telemetry.traceparent() ?? null,
    fns: evalFunctions(
      ctx,
      events,
      now,
      doc.triggers.map((t) => t.sourceId),
    ),
    mapping: mappingContext({ events, process: processView(proc), run, mode }),
  };
}

function gateStep(ctx: Ctx, d: Dispatch): Promise<GateResult> {
  const { batch, proc } = d;
  return ctx.telemetry.span(
    'switchboard.gate',
    { batch_id: batch.id, process_id: proc.id },
    async (gateSpan) => {
      const rule = proc.document.gates.approval;
      const evaluated = approvalNeedsEvaluation(rule, batch)
        ? await evaluateFilter(
            ctx.engine,
            rule,
            approvalContext(d.mapping, { id: batch.id, kind: batch.kind, size: d.events.length }),
            d.fns,
          )
        : null;
      const result = gate(gateInput(ctx, d, rule, evaluated), d.now);
      gateSpan.setAttributes({
        'switchboard.gate.pass': result.pass,
        'switchboard.gate.reason': result.pass ? undefined : result.reason,
      });
      return result;
    },
  );
}

function gateInput(
  ctx: Ctx,
  d: Dispatch,
  rule: string,
  evaluated: { result: boolean; error?: string } | null,
): GateInput {
  const { batch, proc, destinationRow: row } = d;
  const doc = proc.document;
  return {
    dryRun: batch.dryRun,
    process: { enabled: proc.enabled },
    sources: d.sources,
    destination: {
      exists: row !== undefined,
      enabled: row?.enabled ?? false,
      pluginAvailable: row ? ctx.runtime.destinationType(row.typeId) !== undefined : false,
      live: d.live !== undefined,
      instanceError: ctx.runtime.instanceError(d.destinationId),
      health: row?.health ?? null,
    },
    breaker: {
      state: proc.breakerState,
      openedAt: proc.breakerOpenedAt,
      cooldownMinutes: doc.gates.breaker.cooldownMinutes,
    },
    quietHours: doc.gates.quietHours ?? d.settings.defaultQuietHours,
    defaultTimezone: d.settings.timezone,
    approval: {
      rule,
      required: approvalRequired(rule, evaluated),
      state: batch.approvalState,
      ...(evaluated?.error !== undefined ? { error: evaluated.error } : {}),
    },
  };
}

function gateRecord(c: GateCheck, at: string): GateDecisionRecord {
  return {
    stage: 'gate',
    check: c.check,
    pass: c.pass,
    ...(c.detail !== undefined ? { detail: c.detail } : {}),
    at,
  };
}

/** Input mapping, validated before any budget is spent. */
function mapInput(ctx: Ctx, d: Dispatch): Promise<MappingOutcome> {
  return evaluateMapping(
    ctx.engine,
    d.proc.document.input,
    d.mapping,
    d.fns,
    d.live?.type.inputSchema,
  );
}

function approvalPreview(m: MappingOutcome): unknown {
  return m.ok ? m.input : (m.input ?? { errors: m.errors });
}

function newRun(
  d: Dispatch,
  values: Pick<typeof runs.$inferInsert, 'status' | 'input'> & Partial<typeof runs.$inferInsert>,
): typeof runs.$inferInsert {
  return {
    id: d.runId,
    batchId: d.batch.id,
    processId: d.proc.id,
    processVersion: d.proc.version,
    destinationId: d.destinationId,
    kind: d.batch.kind,
    dryRun: d.batch.dryRun,
    attempts: 0,
    firstEventAt: firstEventAt(d.events),
    traceContext: d.runTrace,
    createdAt: d.now,
    ...values,
  };
}

async function failInput(
  ctx: Ctx,
  d: Dispatch,
  mapped: Extract<MappingOutcome, { ok: false }>,
  gateRecords: GateDecisionRecord[],
): Promise<DispatchResult> {
  const { batch, proc, runId } = d;
  const record: GateDecisionRecord = {
    stage: 'budget',
    check: 'input',
    pass: false,
    detail: `input_invalid: ${mapped.errors.join('; ')}`.slice(0, 1000),
    at: d.at,
  };
  const created = await withTx(ctx.db, async (tx) => {
    if (!(await lockClosedBatch(tx, batch.id))) return false;
    await tx.insert(runs).values(
      newRun(d, {
        status: 'failed',
        statusReason: 'input_invalid',
        input: mapped.input ?? null,
        errors: mapped.errors,
        finishedAt: d.now,
      }),
    );
    await tx
      .update(batches)
      .set({
        outcome: 'invoked',
        outcomeReason: 'input_invalid',
        decisions: appendDecisions([...gateRecords, record]),
      })
      .where(eq(batches.id, batch.id));
    return true;
  });
  if (created) {
    signalBatch(ctx, batch, 'invoked', 'input_invalid', runId);
    ctx.telemetry.decision(
      'switchboard.runs',
      { process: proc.id, destination: d.destinationId, status: 'failed' },
      { process_id: proc.id, batch_id: batch.id, run_id: runId },
    );
    await ctx.queue.send(JOBS.finish, { runId });
  }
  return { batchId: batch.id, runId: created ? runId : null, outcome: 'failed' };
}

type Reservation =
  | { outcome: 'gone'; result: null }
  | { outcome: 'throttled'; result: BudgetResult }
  | { outcome: 'reserved'; result: BudgetResult | null };

/** Budget check and reservation in one transaction, serialised per destination. */
function reserve(
  ctx: Ctx,
  d: Dispatch,
  live: LiveDestination,
  input: unknown,
  gateRecords: GateDecisionRecord[],
): Promise<Reservation> {
  const { batch, proc, destinationId } = d;
  const run = (): Promise<Reservation> =>
    withTx(ctx.db, async (tx) => {
      await lockKey(tx, `destination:${destinationId}`);
      if (!(await lockClosedBatch(tx, batch.id))) return { outcome: 'gone', result: null };
      const checked = batch.dryRun
        ? { result: null, record: dryRunBudgetRecord(d.at) }
        : await checkBudget(tx, d, live);
      const records = [...gateRecords, checked.record];
      if (checked.result && !checked.result.ok) {
        await tx
          .update(batches)
          .set({
            outcome: 'throttled',
            outcomeReason: checked.result.binding,
            decisions: appendDecisions(records),
          })
          .where(eq(batches.id, batch.id));
        return { outcome: 'throttled', result: checked.result };
      }
      await tx.insert(runs).values(
        newRun(d, {
          status: 'invoking',
          input,
          invokedAt: d.now,
          deadlineAt: trackingDeadline(d.now, proc.document.trackingDeadlineMinutes),
        }),
      );
      await tx
        .update(batches)
        .set({ outcome: 'invoked', outcomeReason: null, decisions: appendDecisions(records) })
        .where(eq(batches.id, batch.id));
      return { outcome: 'reserved', result: checked.result };
    });
  return ctx.telemetry.span(
    'switchboard.budget',
    { batch_id: batch.id, process_id: proc.id, destination_id: destinationId },
    async (budgetSpan) => {
      const out = await run();
      budgetSpan.setAttributes({
        'switchboard.budget.outcome': out.outcome,
        'switchboard.budget.binding': out.result?.binding ?? undefined,
      });
      return out;
    },
  );
}

async function checkBudget(
  tx: Tx,
  d: Dispatch,
  live: LiveDestination,
): Promise<{ result: BudgetResult; record: GateDecisionRecord }> {
  const { destinationId, now } = d;
  const budgets = d.proc.document.budgets;
  const [ex] = await tx.select().from(destinations).where(eq(destinations.id, destinationId));
  const caps = ex?.caps ?? {};
  const counters = await countersFor(
    tx,
    { processId: d.proc.id, destinationId, dimensions: live.usage },
    now,
  );
  const meters = await meterSnapshots(tx, destinationId, live.meters, caps, now);
  const result = budget(
    {
      kind: d.batch.kind,
      process: {
        runsPerHour: budgets.runsPerHour,
        runsPerDay: budgets.runsPerDay,
        usagePerDay: budgets.usagePerDay,
        meterCeilings: budgets.meterCeilings,
      },
      destination: {
        runsPerHour: caps.runsPerHour,
        runsPerDay: caps.runsPerDay,
        usagePerDay: caps.usagePerDay,
        softHoldUntil: ex?.softHoldUntil ?? null,
        stalenessMinutes: caps.meterStalenessMinutes ?? d.settings.meterStalenessMinutes,
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
    at: d.at,
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
  batch: BatchRow,
  outcome: string,
  reason: string,
  runId: string | null,
): void {
  ctx.telemetry.decision(
    'switchboard.batches',
    { process: batch.processId, kind: batch.kind, outcome, reason },
    { process_id: batch.processId, batch_id: batch.id, run_id: runId ?? undefined },
  );
}

function emitLatency(ctx: Ctx, d: Dispatch): void {
  const first = firstEventAt(d.events);
  if (first) {
    ctx.telemetry.histogram('switchboard.run.latency', (d.now.getTime() - first.getTime()) / 1000, {
      process: d.proc.id,
    });
  }
  if (d.batch.kind === 'sweep' && d.batch.tickAt) {
    ctx.telemetry.histogram(
      'switchboard.schedule.lag',
      (d.now.getTime() - d.batch.tickAt.getTime()) / 1000,
      { process: d.proc.id },
    );
  }
}

function emitBudgetGauges(ctx: Ctx, proc: ProcessRow, result: BudgetResult): void {
  for (const c of result.checks) {
    if (c.used === undefined || c.limit === undefined || c.window === undefined) continue;
    ctx.telemetry.gauge('switchboard.budget.used', c.used, {
      scope: `${proc.id}:${c.check}`,
      window: c.window,
    });
  }
}

async function hold(
  ctx: Ctx,
  batch: BatchRow,
  proc: ProcessRow | null,
  now: Date,
  h: {
    reason: HoldReason;
    detail: string | null;
    records?: GateDecisionRecord[];
    events?: readonly Event[];
    preview?: unknown;
  },
): Promise<void> {
  const awaiting = h.reason === 'awaiting_approval';
  const moved = await withTx(ctx.db, async (tx) => {
    if (!(await lockClosedBatch(tx, batch.id))) return false;
    await tx
      .update(batches)
      .set({
        outcome: awaiting ? 'awaiting_approval' : 'held',
        outcomeReason: h.reason,
        ...(awaiting ? { approvalState: 'pending' as const } : {}),
        decisions: appendDecisions(h.records ?? []),
      })
      .where(eq(batches.id, batch.id));
    if (awaiting && proc) {
      await tx
        .insert(approvals)
        .values({
          batchId: batch.id,
          processId: proc.id,
          rule: proc.document.gates.approval,
          input: h.preview ?? null,
          requestedAt: now,
        })
        .onConflictDoNothing();
    }
    return true;
  });
  if (!moved) return;
  signalBatch(ctx, batch, awaiting ? 'awaiting_approval' : 'held', h.reason, null);
  if (proc) {
    await notifyProcess(ctx, {
      process: proc,
      on: 'held',
      batchId: batch.id,
      events: h.events ?? [],
      context: {
        batch: { id: batch.id, kind: batch.kind },
        reason: h.detail ? `${h.reason}: ${h.detail}` : h.reason,
      },
    });
  }
}
