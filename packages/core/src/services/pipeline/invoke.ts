import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Health, InvokeResult, TrackingMode } from '@ai-switchboard/sdk';

import { batches, destinations, runs } from '../../db/schema.js';
import { instanceErrorText } from '../../domain/instance-error.js';
import {
  classifyInvoke,
  effectiveInvokeTimeoutSeconds,
  invokeAttemptDeadline,
  MAX_INVOKE_ATTEMPTS,
  NO_LIVE_INSTANCE_RETRY_SECONDS,
  statusAfterStart,
  type InvokeClassification,
  type InvokeOutcome,
} from '../../pipeline/invoke.js';
import { redactSecretValues } from '../../secrets/refs.js';
import { errorText } from '../../util/errors.js';
import { addSeconds } from '../../util/time.js';

import type { Ctx } from './context.js';
import { JOBS } from './jobs.js';
import { batchEvents } from './load.js';
import { sendSystemAlert } from './notify.js';
import { beforeStepBudgetSeconds, resolveForPluginCall, timedCall } from './plugin-call.js';
import { closeRun, markUncertain, recordUpdate, runHandle, scheduleTracking } from './runs.js';
import { runSteps } from './steps.js';
import { runTarget } from './target.js';
import type { RunRow } from './views.js';

/**
 * The attempt is claimed with a conditional update, so two replicas never invoke the same run.
 * Secret references in the input are resolved immediately before the call and never stored.
 */

function isInvokeResult(value: unknown): value is InvokeResult {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { status?: unknown }).status === 'string'
  );
}

export function attemptInvoke(ctx: Ctx, runId: string): Promise<void> {
  return ctx.telemetry.span('switchboard.invoke', { run_id: runId }, () =>
    attemptInvokeInSpan(ctx, runId),
  );
}

async function attemptInvokeInSpan(ctx: Ctx, runId: string): Promise<void> {
  const [pending] = await ctx.db.select().from(runs).where(eq(runs.id, runId));
  if (pending?.status !== 'invoking' || pending.invokeStartedAt !== null) return;
  const resolved = await runTarget(ctx, pending);
  const timeoutSeconds = effectiveInvokeTimeoutSeconds({
    cap: resolved.row?.caps.invokeTimeoutSeconds,
    perTarget: resolved.ready ? resolved.live.invokeTimeoutFor(resolved.target) : undefined,
  });

  // Claim the attempt with its recovery deadline: until then recovery leaves it alone, since the
  // worker may legitimately still be running the steps or waiting on the backend.
  const now = ctx.clock.now();
  const deadline = invokeAttemptDeadline(
    now,
    timeoutSeconds,
    beforeStepBudgetSeconds(resolved.proc?.document.before.length ?? 0),
  );
  const [run] = await ctx.db
    .update(runs)
    .set({
      invokeStartedAt: now,
      invokeDeadlineAt: deadline,
      attempts: sql`${runs.attempts} + 1`,
      nextPollAt: null,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, 'invoking'), isNull(runs.invokeStartedAt)))
    .returning();
  if (!run) return;
  ctx.telemetry.annotate({
    process_id: run.processId,
    batch_id: run.batchId,
    destination_id: run.destinationId,
    plugin: resolved.live?.pluginName,
    'switchboard.invoke.attempt': run.attempts,
    'switchboard.run.dry_run': run.dryRun,
  });
  if (!resolved.ready) {
    // Nothing was sent: retry later, like a connection refused.
    const reason = `destination ${run.destinationId} has no live instance`;
    const cls: InvokeClassification =
      run.attempts < MAX_INVOKE_ATTEMPTS
        ? { action: 'retry', reason, delaySeconds: NO_LIVE_INSTANCE_RETRY_SECONDS }
        : {
            action: 'failed',
            reason: 'destination_unavailable',
            errors: [instanceErrorText(ctx.runtime.instanceError(run.destinationId)) ?? reason],
          };
    await apply(ctx, run, cls, 'none');
    return;
  }
  const { proc, live, target } = resolved;
  const tracking = live.trackingFor(target);
  const idempotent = live.idempotentFor(target);

  // Steps run under this attempt's claim, so recovery never invokes past a step still in flight.
  // A retried attempt skips settled steps, re-runs an in-doubt idempotent step, and fails on a
  // non-idempotent one.
  if (proc.document.before.length > 0) {
    const [batch] = await ctx.db.select().from(batches).where(eq(batches.id, run.batchId));
    const events = batch ? await batchEvents(ctx.db, batch) : [];
    const steps = await runSteps(ctx, 'before', run, proc, events);
    if (!steps.ok) {
      // Nothing was sent: the run does not count toward budgets and has no after phase.
      await ctx.db
        .update(runs)
        .set({ attempts: 0 })
        .where(and(eq(runs.id, run.id), eq(runs.status, 'invoking')));
      await closeRun(ctx, run.id, {
        status: 'failed',
        source: 'invoke',
        reason: steps.reason,
      });
      return;
    }
  }

  let input: unknown;
  let secretValues: readonly string[];
  try {
    ({ value: input, secretValues } = await resolveForPluginCall(
      ctx,
      run.input,
      live.secretValues ?? [],
    ));
  } catch (err) {
    await apply(
      ctx,
      run,
      { action: 'failed', reason: 'secret_error', errors: [errorText(err)] },
      tracking,
    );
    return;
  }

  // No answer within the effective timeout is a lost response (the request may have reached
  // the backend), not a plugin error: the idempotency rule decides, never a blind second invoke.
  let outcome: InvokeOutcome;
  try {
    const handle = runHandle(ctx, run, proc.name);
    const answered = await timedCall(timeoutSeconds * 1000, () =>
      live.destination.invoke(target, input, handle),
    );
    if (answered.timedOut) {
      outcome = { kind: 'timeout', seconds: timeoutSeconds };
    } else {
      const result: unknown = answered.value;
      outcome = isInvokeResult(result)
        ? { kind: 'result', result }
        : { kind: 'error', error: new Error('invoke returned a malformed InvokeResult') };
    }
  } catch (err) {
    outcome = { kind: 'error', error: err };
  }
  // A backend may echo what it received (credentials, the input): never store a secret value.
  const cls = redactSecretValues(
    classifyInvoke({ idempotent, attempt: run.attempts }, outcome),
    secretValues,
  ) as InvokeClassification;
  ctx.log.info(
    {
      run_id: run.id,
      process_id: run.processId,
      action: cls.action,
      attempt: run.attempts,
      ...(outcome.kind === 'timeout' ? { invoke_timeout_seconds: timeoutSeconds } : {}),
    },
    'invoke classified',
  );
  ctx.telemetry.annotate({ 'switchboard.invoke.action': cls.action });
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
      .update(destinations)
      .set({
        softHoldUntil: sql`GREATEST(COALESCE(${destinations.softHoldUntil}, ${until}), ${until})`,
        softHoldReason: `retry after ${soft} s (run ${run.id})`,
      })
      .where(eq(destinations.id, run.destinationId));
  }
  if (cls.action === 'failed' && cls.unhealthy) {
    const health: Health = {
      status: 'unhealthy',
      message: `credentials refused: ${cls.errors.join('; ')}`,
      checkedAt: now.toISOString(),
    };
    const [ex] = await ctx.db
      .update(destinations)
      .set({ health })
      .where(eq(destinations.id, run.destinationId))
      .returning({ name: destinations.name });
    ctx.telemetry.gauge('switchboard.destination.health', 0, { destination: run.destinationId });
    await sendSystemAlert(ctx, {
      key: `destination_unhealthy:${run.destinationId}`,
      title: `Destination unhealthy: ${ex?.name ?? run.destinationId}`,
      text: `Invokes to ${ex?.name ?? run.destinationId} are refused (${cls.reason}). Every process bound to it is held until the credentials are rotated and the instance reloaded.`,
      severity: 'error',
    });
  }

  switch (cls.action) {
    case 'retry': {
      const at = addSeconds(now, cls.delaySeconds);
      const moved = await ctx.db
        .update(runs)
        .set({ invokeStartedAt: null, invokeDeadlineAt: null, nextPollAt: at })
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
          invokeDeadlineAt: null,
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
