import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Health, InvokeResult, TrackingMode } from '@ai-switchboard/sdk';

import { batches, executors, processes, runs } from '../../db/schema.js';
import { resolveSecretRefs } from '../../expr/index.js';
import { redactSecretValues } from '../../secrets/refs.js';
import {
  classifyInvoke,
  MAX_INVOKE_ATTEMPTS,
  statusAfterStart,
  type InvokeClassification,
  type InvokeOutcome,
} from '../../pipeline/invoke.js';

import { JOBS, addSeconds, errorMessage, type Ctx } from './context.js';
import { batchEvents } from './load.js';
import { sendSystemAlert } from './notify.js';
import { closeRun, markUncertain, recordUpdate, runHandle, scheduleTracking } from './runs.js';
import { runSteps, type RunRow } from './steps.js';

/**
 * The executor bridge: one invoke attempt for a reserved run. The attempt is claimed with a
 * conditional update, so two replicas never invoke the same run; secret references in the input
 * are resolved immediately before the call and never stored.
 */

function targetFor(
  document: { executor: { target: unknown } },
  defaults: Record<string, unknown>,
): unknown {
  const t = document.executor.target;
  if (t !== null && typeof t === 'object' && !Array.isArray(t)) {
    return { ...defaults, ...(t as Record<string, unknown>) };
  }
  return t ?? defaults;
}

function isInvokeResult(value: unknown): value is InvokeResult {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { status?: unknown }).status === 'string'
  );
}

/** `pipeline.invoke` and the dispatch stage's first attempt. */
export async function attemptInvoke(ctx: Ctx, runId: string): Promise<void> {
  const now = ctx.clock.now();
  const [run] = await ctx.db
    .update(runs)
    .set({ invokeStartedAt: now, attempts: sql`${runs.attempts} + 1`, nextPollAt: null })
    .where(and(eq(runs.id, runId), eq(runs.status, 'invoking'), isNull(runs.invokeStartedAt)))
    .returning();
  if (!run) return;
  const [proc] = await ctx.db.select().from(processes).where(eq(processes.id, run.processId));
  const [exRow] = await ctx.db.select().from(executors).where(eq(executors.id, run.executorId));
  const live = ctx.runtime.executor(run.executorId);
  if (!proc || !exRow || !live) {
    // Nothing was sent: retry later, like a connection refused.
    const reason = `executor ${run.executorId} has no live instance`;
    const cls: InvokeClassification =
      run.attempts < MAX_INVOKE_ATTEMPTS
        ? { action: 'retry', reason, delaySeconds: 30 }
        : {
            action: 'failed',
            reason: 'executor_unavailable',
            errors: [ctx.runtime.instanceError(run.executorId) ?? reason],
          };
    await apply(ctx, run, cls, 'none');
    return;
  }
  const target = targetFor(proc.document, exRow.targetDefaults);
  const tracking = live.trackingFor(target);
  const idempotent = live.idempotentFor(target);

  // `before` steps run under this attempt's claim, so recovery never invokes past a step that is
  // still in flight (a claimed attempt is only ever made `uncertain`). `runSteps` is idempotent
  // per run: a resumed or retried attempt reuses the recorded outcome.
  if (proc.document.before.length > 0) {
    const [batch] = await ctx.db.select().from(batches).where(eq(batches.id, run.batchId));
    const events = batch ? await batchEvents(ctx.db, batch) : [];
    const stepsOk = await runSteps(ctx, 'before', run, proc, events);
    if (!stepsOk) {
      // Nothing was sent: the run does not count toward budgets and has no after phase.
      await ctx.db
        .update(runs)
        .set({ attempts: 0 })
        .where(and(eq(runs.id, run.id), eq(runs.status, 'invoking')));
      await closeRun(ctx, run.id, {
        status: 'failed',
        source: 'invoke',
        reason: 'before_step_failed',
      });
      return;
    }
  }

  // Every secret value this attempt handles: the resolved input's and the instance's own.
  const secretValues: string[] = [...(live.secretValues ?? [])];
  let input: unknown;
  try {
    input = await resolveSecretRefs(run.input, async (ref) => {
      const value = await ctx.secrets.resolve(ref);
      secretValues.push(value);
      return value;
    });
  } catch (err) {
    await apply(
      ctx,
      run,
      { action: 'failed', reason: 'secret_error', errors: [errorMessage(err)] },
      tracking,
    );
    return;
  }

  let outcome: InvokeOutcome;
  try {
    const result: unknown = await live.executor.invoke(
      target,
      input,
      runHandle(ctx, run, proc.name),
    );
    outcome = isInvokeResult(result)
      ? { kind: 'result', result }
      : { kind: 'error', error: new Error('invoke returned a malformed InvokeResult') };
  } catch (err) {
    outcome = { kind: 'error', error: err };
  }
  // A backend may echo what it received (credentials, the input): never store a secret value.
  const cls = redactSecretValues(
    classifyInvoke({ idempotent, attempt: run.attempts }, outcome),
    secretValues,
  ) as InvokeClassification;
  ctx.log.info(
    { run_id: run.id, process_id: run.processId, action: cls.action, attempt: run.attempts },
    'invoke classified',
  );
  await apply(ctx, run, cls, tracking);
}

async function apply(
  ctx: Ctx,
  run: RunRow,
  cls: InvokeClassification,
  tracking: TrackingMode,
): Promise<void> {
  const now = ctx.clock.now();
  const soft = 'softHoldSeconds' in cls ? cls.softHoldSeconds : undefined;
  if (soft !== undefined) {
    const until = addSeconds(now, soft);
    await ctx.db
      .update(executors)
      .set({
        softHoldUntil: sql`GREATEST(COALESCE(${executors.softHoldUntil}, ${until}), ${until})`,
        softHoldReason: `retry after ${soft} s (run ${run.id})`,
      })
      .where(eq(executors.id, run.executorId));
  }
  if (cls.action === 'failed' && cls.unhealthy) {
    const health: Health = {
      status: 'unhealthy',
      message: `credentials refused: ${cls.errors.join('; ')}`,
      checkedAt: now.toISOString(),
    };
    const [ex] = await ctx.db
      .update(executors)
      .set({ health })
      .where(eq(executors.id, run.executorId))
      .returning({ name: executors.name });
    ctx.telemetry.gauge('switchboard.executor.health', 0, { executor: run.executorId });
    await sendSystemAlert(ctx, {
      key: `executor_unhealthy:${run.executorId}`,
      title: `Executor unhealthy: ${ex?.name ?? run.executorId}`,
      text: `Invokes to ${ex?.name ?? run.executorId} are refused (${cls.reason}). Every process bound to it is held until the credentials are rotated and the instance reloaded.`,
      severity: 'error',
    });
  }

  switch (cls.action) {
    case 'retry': {
      const at = addSeconds(now, cls.delaySeconds);
      const moved = await ctx.db
        .update(runs)
        .set({ invokeStartedAt: null, nextPollAt: at })
        .where(and(eq(runs.id, run.id), eq(runs.status, 'invoking')))
        .returning({ id: runs.id });
      if (moved.length === 0) return;
      await recordUpdate(ctx, run.id, 'invoke', 'invoking', {
        retry: true,
        reason: cls.reason,
        attempt: run.attempts,
        retryAt: at.toISOString(),
      });
      await ctx.queue.send(JOBS.invoke, { runId: run.id }, { startAfter: at });
      return;
    }
    case 'uncertain':
      await markUncertain(ctx, run.id, {
        source: 'invoke',
        reason: cls.reason,
        detail: { reason: cls.reason, attempt: run.attempts },
      });
      return;
    case 'started': {
      const status = statusAfterStart(tracking);
      if (status === 'ok') {
        await closeRun(ctx, run.id, {
          status: 'ok',
          source: 'invoke',
          reason: 'accepted (tracking none)',
          externalId: cls.externalId ?? null,
          externalUrl: cls.externalUrl ?? null,
        });
        return;
      }
      const [moved] = await ctx.db
        .update(runs)
        .set({
          status: 'running',
          invokeStartedAt: null,
          externalId: sql`COALESCE(${runs.externalId}, ${cls.externalId ?? null})`,
          externalUrl: sql`COALESCE(${cls.externalUrl ?? null}, ${runs.externalUrl})`,
        })
        .where(and(eq(runs.id, run.id), inArray(runs.status, ['invoking', 'uncertain'])))
        .returning();
      if (!moved) {
        // A callback closed the run while invoke was in flight; keep the external reference.
        await ctx.db
          .update(runs)
          .set({
            externalId: sql`COALESCE(${runs.externalId}, ${cls.externalId ?? null})`,
            externalUrl: sql`COALESCE(${runs.externalUrl}, ${cls.externalUrl ?? null})`,
          })
          .where(eq(runs.id, run.id));
        return;
      }
      await recordUpdate(ctx, run.id, 'invoke', 'running', {
        ...(cls.externalId ? { externalId: cls.externalId } : {}),
        ...(cls.externalUrl ? { externalUrl: cls.externalUrl } : {}),
        attempt: run.attempts,
      });
      await scheduleTracking(ctx, moved, 0);
      return;
    }
    case 'completed':
      await closeRun(ctx, run.id, {
        status: cls.status,
        source: 'invoke',
        result: cls.result ?? null,
        ...(cls.usage !== undefined ? { usage: cls.usage } : {}),
        ...(cls.errors ? { errors: cls.errors } : {}),
        externalId: cls.externalId ?? null,
        externalUrl: cls.externalUrl ?? null,
      });
      return;
    case 'held':
      await closeRun(ctx, run.id, {
        status: 'held',
        source: 'invoke',
        reason: `paused:${cls.reason}`,
        externalId: cls.externalId ?? null,
        externalUrl: cls.externalUrl ?? null,
      });
      return;
    case 'failed':
      await closeRun(ctx, run.id, {
        status: 'failed',
        source: 'invoke',
        reason: cls.reason,
        errors: cls.errors,
      });
      return;
  }
}
