import { and, eq } from 'drizzle-orm';

import type { ActionResult, ActionSpec, Event } from '@ai-switchboard/sdk';

import { steps } from '../../db/schema.js';
import type { StepPhase } from '../../domain/status.js';
import { evaluateFilter, stepContext, type EvalFunctions } from '../../expr/index.js';
import { redactSecretValues } from '../../secrets/refs.js';
import { errorText } from '../../util/errors.js';

import type { Ctx } from './context.js';
import { evalFunctions } from './eval.js';
import { callPlugin, resolveForPluginCall } from './plugin-call.js';
import { runView, type ProcessRow, type RunRow } from './views.js';

/**
 * A failing `before` step fails the run before invoke; `after` steps run on the terminal state
 * and never change it. Dry runs record every step as skipped, since actions have side effects.
 */

/** `ok: false` only when a `before` phase must fail the run. */
export type StepsOutcome = { ok: true } | { ok: false; reason: string };

type StepRow = typeof steps.$inferSelect;
type StepValues = Pick<StepRow, 'status'> & Partial<Pick<StepRow, 'args' | 'error'>>;
type Step = ProcessRow['document']['before'][number];

/** A source or destination instance that can run a step's action. */
interface ActionProvider {
  actions: readonly ActionSpec[];
  secretValues: readonly string[];
  act: ((action: string, args: unknown) => Promise<ActionResult>) | undefined;
}

function actionProvider(ctx: Ctx, id: string): ActionProvider | undefined {
  const source = ctx.runtime.source(id);
  if (source) {
    return {
      actions: source.type.actions ?? [],
      secretValues: source.secretValues,
      act: source.source.act?.bind(source.source),
    };
  }
  const destination = ctx.runtime.destination(id);
  if (!destination) return undefined;
  return {
    actions: destination.type.actions ?? [],
    secretValues: destination.secretValues,
    act: destination.destination.act?.bind(destination.destination),
  };
}

function actionIdempotent(provider: ActionProvider | undefined, action: string): boolean {
  return provider?.actions.find((a) => a.id === action)?.idempotent === true;
}

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

interface PhaseContext {
  ctx: Ctx;
  phase: StepPhase;
  run: RunRow;
  fns: EvalFunctions;
  sctx: unknown;
}

/** How one step ended: `failed` stops a `before` phase; `in_doubt` names the step. */
type StepEnd = 'ok' | 'failed' | 'in_doubt';

/**
 * Each step's row is written `started` before its action runs and settled after, so a resumed or
 * redelivered phase knows exactly where the last attempt stopped:
 * - a settled step (`ok`, `skipped`, `uncertain`) is not run again; a recorded `before` error
 *   fails the phase again;
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
  const rows = await ctx.db
    .select()
    .from(steps)
    .where(and(eq(steps.runId, run.id), eq(steps.phase, phase)));
  const journal = new Map(rows.map((r) => [r.index, r]));
  const now = ctx.clock.now();
  const pc: PhaseContext = {
    ctx,
    phase,
    run,
    fns: evalFunctions(ctx, events, now),
    sctx: stepContext({
      events: [...events],
      run: runView(run),
      ...(phase === 'after' ? { result } : {}),
    }),
  };
  let allOk = true;
  for (const [index, step] of list.entries()) {
    const end = await runStep(pc, index, step, journal.get(index));
    if (end === 'ok') continue;
    if (phase === 'before') {
      return end === 'in_doubt'
        ? { ok: false, reason: `step_in_doubt:before[${index}] ${step.action}` }
        : { ok: false, reason: 'before_step_failed' };
    }
    if (end === 'failed') allOk = false;
  }
  return allOk ? { ok: true } : { ok: false, reason: 'after_step_failed' };
}

async function runStep(
  pc: PhaseContext,
  index: number,
  step: Step,
  prior: StepRow | undefined,
): Promise<StepEnd> {
  const { ctx, phase, run } = pc;
  if (prior && prior.status !== 'started') return prior.status === 'error' ? 'failed' : 'ok';
  const provider = actionProvider(ctx, step.provider);
  if (prior && !actionIdempotent(provider, step.action)) {
    if (phase === 'before') return 'in_doubt';
    await ctx.db
      .update(steps)
      .set({
        status: 'uncertain',
        error: 'in doubt after an interrupted attempt; not repeated (the action is not idempotent)',
      })
      .where(and(eq(steps.id, prior.id), eq(steps.status, 'started')));
    ctx.log.warn(
      { run_id: run.id, process_id: run.processId, step: index, action: step.action },
      'after step in doubt; recorded uncertain',
    );
    return 'ok';
  }

  const journal = stepJournal(ctx, run, phase, index, step, prior);
  if (run.dryRun) {
    await journal.settle({ status: 'skipped', error: 'dry run' });
    return 'ok';
  }
  if (step.when !== undefined && step.when.trim() !== '') {
    const when = await evaluateFilter(ctx.engine, step.when, pc.sctx, pc.fns);
    if (!when.result) {
      await journal.settle({
        status: 'skipped',
        error: when.error !== undefined ? `when: ${when.error}` : null,
      });
      return 'ok';
    }
  }
  const args = await ctx.engine.evaluate(step.args, pc.sctx, pc.fns);
  if (!args.ok) {
    await journal.settle({ status: 'error', error: `args: ${args.error}` });
    return 'failed';
  }
  const act = provider?.act;
  if (!provider || !act) {
    await journal.settle({
      status: 'error',
      args: args.value,
      error: `provider ${step.provider} is not available or has no actions`,
    });
    return 'failed';
  }

  const claimedId = await journal.claim(args.value);
  // Another worker claimed this step between the read and now; it owns the outcome.
  if (claimedId === null) return phase === 'before' ? 'in_doubt' : 'ok';

  let error: string | null = null;
  let secretValues = provider.secretValues;
  try {
    const resolved = await resolveForPluginCall(ctx, args.value, secretValues);
    secretValues = resolved.secretValues;
    const out = await callPlugin(`act ${step.action}`, () => act(step.action, resolved.value));
    if (!out.ok) error = out.error;
    else if (!out.value.ok) error = out.value.message ?? 'action failed';
  } catch (err) {
    error = errorText(err);
  }
  // An action's error may echo what it was sent: never store a secret value.
  await ctx.db
    .update(steps)
    .set({
      status: error === null ? 'ok' : 'error',
      error: error === null ? null : (redactSecretValues(error, secretValues) as string),
      at: ctx.clock.now(),
    })
    .where(eq(steps.id, claimedId));
  return error === null ? 'ok' : 'failed';
}

/** Writes to one step's journal row: the row left by an earlier attempt, or a new one. */
function stepJournal(
  ctx: Ctx,
  run: RunRow,
  phase: StepPhase,
  index: number,
  step: Step,
  prior: StepRow | undefined,
) {
  const write = async (values: StepValues): Promise<string | null> => {
    const at = ctx.clock.now();
    if (prior) {
      const [row] = await ctx.db
        .update(steps)
        .set({ ...values, at })
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
        args: values.args ?? null,
        status: values.status,
        error: values.error ?? null,
        at,
      })
      .onConflictDoNothing()
      .returning({ id: steps.id });
    return row?.id ?? null;
  };
  return {
    /** `started` with these args; null when another worker got there first. */
    claim: (args: unknown) => write({ status: 'started', args: args ?? null, error: null }),
    settle: async (values: StepValues): Promise<void> => {
      await write(values);
    },
  };
}

/** False means the attempt stopped in its steps, so `invoke` was certainly never called for it. */
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
