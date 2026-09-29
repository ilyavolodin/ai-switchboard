import { and, eq } from 'drizzle-orm';

import type { Event } from '@ai-switchboard/sdk';

import { steps, type runs } from '../../db/schema.js';
import type { StepPhase } from '../../domain/status.js';
import { evaluateFilter, resolveSecretRefs, stepContext } from '../../expr/index.js';
import { redactSecretValues } from '../../secrets/refs.js';

import { callPlugin, errorMessage, evalFunctions, type Ctx, type ProcessRow } from './context.js';

/**
 * `before` and `after` steps: actions on a source or destination instance, with arguments and an
 * optional `when`, each journaled in `steps` (unique per run, phase and index). A failing
 * `before` step fails the run before invoke; `after` steps run on the terminal state and never
 * change it. Dry runs record every step as skipped (actions have side effects).
 */

export type RunRow = typeof runs.$inferSelect;

export function runView(run: RunRow): Record<string, unknown> {
  return {
    id: run.id,
    processId: run.processId,
    destinationId: run.destinationId,
    status: run.status,
    reason: run.statusReason,
    mode: run.kind,
    dryRun: run.dryRun,
    externalId: run.externalId,
    externalUrl: run.externalUrl,
    usage: run.usage,
    invokedAt: run.invokedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/** What running a phase's steps came to. `reason` is set when a `before` phase must fail the run. */
export type StepsOutcome = { ok: true } | { ok: false; reason: string };

type StepRow = typeof steps.$inferSelect;
type StepValues = Pick<StepRow, 'status'> & Partial<Pick<StepRow, 'args' | 'error'>>;

/** Whether the provider declares the action idempotent (`ActionSpec.idempotent`). */
function actionIdempotent(ctx: Ctx, provider: string, action: string): boolean {
  const source = ctx.runtime.source(provider);
  const actions = source ? source.type.actions : ctx.runtime.destination(provider)?.type.actions;
  return actions?.find((a) => a.id === action)?.idempotent === true;
}

/** A run's `before` or `after` steps, in a `switchboard.steps` span when there are any. */
export function runSteps(
  ctx: Ctx,
  phase: StepPhase,
  run: RunRow,
  process: ProcessRow,
  events: readonly Event[],
  result?: unknown,
): Promise<StepsOutcome> {
  const count = process.document[phase].length;
  if (count === 0) return Promise.resolve({ ok: true });
  return ctx.telemetry.span(
    'switchboard.steps',
    {
      run_id: run.id,
      process_id: run.processId,
      'switchboard.steps.phase': phase,
      'switchboard.steps.count': count,
    },
    () => runStepsInSpan(ctx, phase, run, process, events, result),
  );
}

/**
 * Run the process's steps for `phase` against the step journal. Each step's row is written
 * `started` before its action runs and settled (`ok`/`error`) after, so a resumed or redelivered
 * phase knows exactly where the last attempt stopped:
 * - a settled step (`ok`, `skipped`, `uncertain`) is not run again; a recorded `before` error
 *   fails the phase again;
 * - a step never started runs;
 * - a step left `started` is in doubt (the action may or may not have happened). It is re-run
 *   when its action is idempotent. Otherwise a `before` phase fails with
 *   `step_in_doubt:before[<index>] <action>` (so nothing is invoked) and an `after` step is
 *   recorded `uncertain` and the phase continues.
 */
async function runStepsInSpan(
  ctx: Ctx,
  phase: StepPhase,
  run: RunRow,
  process: ProcessRow,
  events: readonly Event[],
  result?: unknown,
): Promise<StepsOutcome> {
  const list = process.document[phase];
  if (list.length === 0) return { ok: true };
  const rows = await ctx.db
    .select()
    .from(steps)
    .where(and(eq(steps.runId, run.id), eq(steps.phase, phase)));
  const journal = new Map(rows.map((r) => [r.index, r]));

  const now = ctx.clock.now();
  const fns = evalFunctions(ctx, events, now);
  const sctx = stepContext({
    events: [...events],
    run: runView(run),
    ...(phase === 'after' ? { result } : {}),
  });
  const failed = (): StepsOutcome => ({ ok: false, reason: 'before_step_failed' });
  let allOk = true;

  for (const [index, step] of list.entries()) {
    const prior = journal.get(index);
    if (prior && prior.status !== 'started') {
      if (prior.status === 'error') {
        allOk = false;
        if (phase === 'before') return failed();
      }
      continue;
    }
    if (prior && !actionIdempotent(ctx, step.provider, step.action)) {
      if (phase === 'before') {
        return { ok: false, reason: `step_in_doubt:before[${index}] ${step.action}` };
      }
      await ctx.db
        .update(steps)
        .set({
          status: 'uncertain',
          error:
            'in doubt after an interrupted attempt; not repeated (the action is not idempotent)',
        })
        .where(and(eq(steps.id, prior.id), eq(steps.status, 'started')));
      ctx.log.warn(
        { run_id: run.id, process_id: run.processId, step: index, action: step.action },
        'after step in doubt; recorded uncertain',
      );
      continue;
    }

    /**
     * Claim the step: a new `started` row, or (re-running an in-doubt idempotent step) the
     * `started` row while it is still `started`. Returns the row id, or null when another
     * worker got there first.
     */
    const claim = async (args: unknown): Promise<string | null> => {
      if (prior) {
        const [row] = await ctx.db
          .update(steps)
          .set({ args: args ?? null, error: null, at: ctx.clock.now() })
          .where(and(eq(steps.id, prior.id), eq(steps.status, 'started')))
          .returning({ id: steps.id });
        return row?.id ?? null;
      }
      const [row] = await ctx.db
        .insert(steps)
        .values({
          runId: run.id,
          phase,
          index,
          providerId: step.provider,
          action: step.action,
          args: args ?? null,
          status: 'started',
          error: null,
          at: ctx.clock.now(),
        })
        .onConflictDoNothing()
        .returning({ id: steps.id });
      return row?.id ?? null;
    };
    /** Record an outcome that ran no action (dry run, `when` false, an args error). */
    const settleWithoutAction = async (values: StepValues): Promise<void> => {
      if (prior) {
        await ctx.db
          .update(steps)
          .set({ ...values, at: ctx.clock.now() })
          .where(and(eq(steps.id, prior.id), eq(steps.status, 'started')));
        return;
      }
      await ctx.db
        .insert(steps)
        .values({
          runId: run.id,
          phase,
          index,
          providerId: step.provider,
          action: step.action,
          args: values.args ?? null,
          status: values.status,
          error: values.error ?? null,
          at: ctx.clock.now(),
        })
        .onConflictDoNothing();
    };

    if (run.dryRun) {
      await settleWithoutAction({ status: 'skipped', error: 'dry run' });
      continue;
    }
    if (step.when !== undefined && step.when.trim() !== '') {
      const when = await evaluateFilter(ctx.engine, step.when, sctx, fns);
      if (!when.result) {
        await settleWithoutAction({
          status: 'skipped',
          error: when.error !== undefined ? `when: ${when.error}` : null,
        });
        continue;
      }
    }
    const args = await ctx.engine.evaluate(step.args, sctx, fns);
    if (!args.ok) {
      await settleWithoutAction({ status: 'error', error: `args: ${args.error}` });
      allOk = false;
      if (phase === 'before') return failed();
      continue;
    }

    const source = ctx.runtime.source(step.provider);
    const destination = source ? undefined : ctx.runtime.destination(step.provider);
    const act =
      source?.source.act?.bind(source.source) ??
      destination?.destination.act?.bind(destination.destination);
    if (!act) {
      await settleWithoutAction({
        status: 'error',
        args: args.value,
        error: `provider ${step.provider} is not available or has no actions`,
      });
      allOk = false;
      if (phase === 'before') return failed();
      continue;
    }

    const claimedId = await claim(args.value);
    if (claimedId === null) {
      // Another worker claimed this step between the read and now; it owns the outcome.
      if (phase === 'before') {
        return { ok: false, reason: `step_in_doubt:before[${index}] ${step.action}` };
      }
      continue;
    }

    let status: 'ok' | 'error' = 'ok';
    let error: string | null = null;
    const secretValues: string[] = [...(source?.secretValues ?? destination?.secretValues ?? [])];
    try {
      const resolved = await resolveSecretRefs(args.value, async (ref) => {
        const value = await ctx.secrets.resolve(ref);
        secretValues.push(value);
        return value;
      });
      const plugin = source?.pluginName ?? destination?.pluginName ?? step.provider;
      const out = await callPlugin(ctx, plugin, `act ${step.action}`, () =>
        act(step.action, resolved),
      );
      if (!out.ok) {
        status = 'error';
        error = out.error;
      } else if (!out.value.ok) {
        status = 'error';
        error = out.value.message ?? 'action failed';
      }
    } catch (err) {
      status = 'error';
      error = errorMessage(err);
    }
    // An action's error may echo what it was sent: never store a secret value.
    await ctx.db
      .update(steps)
      .set({
        status,
        error: error === null ? null : (redactSecretValues(error, secretValues) as string),
        at: ctx.clock.now(),
      })
      .where(eq(steps.id, claimedId));
    if (status === 'error') {
      allOk = false;
      if (phase === 'before') return failed();
    }
  }
  return allOk ? { ok: true } : { ok: false, reason: 'after_step_failed' };
}

/**
 * True when every `before` step of `process` has a settled journal row (`ok` or `skipped`), i.e.
 * the attempt may have reached `invoke`. False means the attempt stopped in its steps, so
 * `invoke` was certainly never called for it.
 */
export async function beforeStepsSettled(
  ctx: Pick<Ctx, 'db'>,
  runId: string,
  process: ProcessRow,
): Promise<boolean> {
  const count = process.document.before.length;
  if (count === 0) return true;
  const rows = await ctx.db
    .select({ index: steps.index, status: steps.status })
    .from(steps)
    .where(and(eq(steps.runId, runId), eq(steps.phase, 'before')));
  const settled = new Set(
    rows.filter((r) => r.status === 'ok' || r.status === 'skipped').map((r) => r.index),
  );
  for (let i = 0; i < count; i++) if (!settled.has(i)) return false;
  return true;
}
