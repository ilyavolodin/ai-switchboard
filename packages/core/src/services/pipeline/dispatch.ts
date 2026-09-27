import { randomUUID } from 'node:crypto';

import { eq, inArray, sql } from 'drizzle-orm';

import type { Event } from '@ai-switchboard/sdk';

import {
  approvals,
  batches,
  executors,
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
import { getSettings } from '../settings.js';

import {
  JOBS,
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
 * Stages 5–7 for one closed batch: gate, input mapping (validated before any budget is spent),
 * budget check and reservation in one transaction (the `invoking` run row is the reservation),
 * before steps, then the first invoke attempt.
 */

export interface DispatchResult {
  batchId: string;
  runId: string | null;
  /** The batch outcome (`held`, `throttled`, `awaiting_approval`, …) or the run status. */
  outcome: string;
}

function appendDecisions(records: GateDecisionRecord[]) {
  return sql`${batches.decisions} || ${JSON.stringify(records)}::jsonb`;
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

export async function dispatchBatch(ctx: Ctx, batchId: string): Promise<DispatchResult> {
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
  const mode = modeFor(batch, events);
  const executorId = doc.executor.instanceId;
  const [exRow] = await ctx.db.select().from(executors).where(eq(executors.id, executorId));
  const live = ctx.runtime.executor(executorId);
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
    callbackUrl: `${ctx.config.publicUrl}/callbacks/${executorId}`,
    deadline: trackingDeadline(now, doc.trackingDeadlineMinutes).toISOString(),
  };
  const fallbackSources = doc.triggers.map((t) => t.sourceId);
  const fns = evalFunctions(ctx, events, now, fallbackSources);
  const mctx = mappingContext({ events, process: processView(proc), run, mode });

  // Approval: evaluated only when it can matter.
  const rule = doc.gates.approval;
  let required = rule === 'always';
  let approvalError: string | undefined;
  if (rule !== 'none' && rule !== 'always' && !batch.dryRun && batch.approvalState !== 'approved') {
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

  const g = gate(
    {
      kind: batch.kind,
      dryRun: batch.dryRun,
      process: { enabled: proc.enabled },
      sources: sourceIds.map((id) => ({
        id,
        enabled: sourceRows.find((s) => s.id === id)?.enabled ?? false,
      })),
      executor: {
        exists: exRow !== undefined,
        enabled: exRow?.enabled ?? false,
        pluginAvailable: exRow ? ctx.runtime.executorType(exRow.typeId) !== undefined : false,
        live: live !== undefined,
        instanceError: ctx.runtime.instanceError(executorId),
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
  if (g.breakerClosed) {
    await ctx.db
      .update(processes)
      .set({ breakerState: 'closed', breakerOpenedAt: null, breakerResetAt: now })
      .where(eq(processes.id, proc.id));
    ctx.telemetry.gauge('switchboard.breaker', 0, { process: proc.id });
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
    await hold(ctx, batch, proc, 'executor_unhealthy', 'no live instance', gateRecords, events);
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
        executorId,
        kind: batch.kind,
        status: 'failed',
        statusReason: 'input_invalid',
        input: mapping.input ?? null,
        errors: mapping.errors,
        dryRun: batch.dryRun,
        attempts: 0,
        finishedAt: now,
        firstEventAt: firstEventAt(events),
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
        { process: proc.id, executor: executorId, status: 'failed' },
        { process_id: proc.id, batch_id: batchId, run_id: runId },
      );
      await ctx.queue.send(JOBS.finish, { runId });
    }
    return { batchId, runId: created ? runId : null, outcome: 'failed' };
  }

  // Budget check and reservation in one transaction, serialised per executor instance.
  let result: BudgetResult | null = null;
  const reserved = await withTx(ctx.db, async (tx) => {
    result = null;
    await lockKey(tx, `executor:${executorId}`);
    const [b] = await tx.select().from(batches).where(eq(batches.id, batchId)).for('update');
    if (b?.outcome !== 'closed') return 'gone' as const;
    const [ex] = await tx.select().from(executors).where(eq(executors.id, executorId));
    const records: GateDecisionRecord[] = [...gateRecords];
    if (!batch.dryRun) {
      const counters = await countersFor(
        tx,
        { processId: proc.id, executorId, dimensions: live.usage },
        now,
      );
      const meters = await meterSnapshots(tx, executorId, live.meters, ex?.caps ?? {}, now);
      const caps = ex?.caps ?? {};
      result = budget(
        {
          kind: batch.kind,
          process: {
            runsPerHour: doc.budgets.runsPerHour,
            runsPerDay: doc.budgets.runsPerDay,
            usagePerDay: doc.budgets.usagePerDay,
            meterCeilings: doc.budgets.meterCeilings,
          },
          executor: {
            runsPerHour: caps.runsPerHour,
            runsPerDay: caps.runsPerDay,
            usagePerDay: caps.usagePerDay,
            softHoldUntil: ex?.softHoldUntil ?? null,
            stalenessMinutes: caps.meterStalenessMinutes ?? settings.meterStalenessMinutes,
          },
          counters,
          dimensions: live.usage,
          meters,
        },
        now,
      );
      records.push({
        stage: 'budget',
        check: 'budget',
        pass: result.ok,
        ...(result.detail !== null ? { detail: result.detail } : {}),
        at,
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
      });
      if (!result.ok) {
        await tx
          .update(batches)
          .set({
            outcome: 'throttled',
            outcomeReason: result.binding,
            decisions: appendDecisions(records),
          })
          .where(eq(batches.id, batchId));
        return 'throttled' as const;
      }
    } else {
      records.push({
        stage: 'budget',
        check: 'budget',
        pass: true,
        detail: 'dry run: not counted',
        at,
      });
    }
    await tx.insert(runs).values({
      id: runId,
      batchId,
      processId: proc.id,
      processVersion: proc.version,
      executorId,
      kind: batch.kind,
      status: 'invoking',
      input: mapping.input,
      dryRun: batch.dryRun,
      attempts: 0,
      invokedAt: now,
      deadlineAt: trackingDeadline(now, doc.trackingDeadlineMinutes),
      firstEventAt: firstEventAt(events),
      createdAt: now,
    });
    await tx
      .update(batches)
      .set({ outcome: 'invoked', outcomeReason: null, decisions: appendDecisions(records) })
      .where(eq(batches.id, batchId));
    return 'reserved' as const;
  });

  const budgetResult = result as BudgetResult | null;
  if (budgetResult) emitBudgetGauges(ctx, proc, budgetResult);
  if (reserved === 'gone') {
    const existing = await existingRun(ctx, batchId);
    const [b] = await ctx.db.select().from(batches).where(eq(batches.id, batchId));
    return {
      batchId,
      runId: existing?.id ?? null,
      outcome: existing?.status ?? b?.outcome ?? 'missing',
    };
  }
  if (reserved === 'throttled') {
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

/** Persist a held batch (and its approval request) and notify. */
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
