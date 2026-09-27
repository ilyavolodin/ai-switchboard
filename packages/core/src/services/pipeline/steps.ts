import { and, eq } from 'drizzle-orm';

import type { Event } from '@ai-switchboard/sdk';

import { steps, type runs } from '../../db/schema.js';
import type { StepPhase, StepStatus } from '../../domain/status.js';
import { evaluateFilter, resolveSecretRefs, stepContext } from '../../expr/index.js';
import { redactSecretValues } from '../../secrets/refs.js';

import { errorMessage, evalFunctions, type Ctx, type ProcessRow } from './context.js';

/**
 * `before` and `after` steps: actions on a source or executor instance, with arguments and an
 * optional `when`, each recorded in `steps`. A failing `before` step fails the run before invoke;
 * `after` steps run on the terminal state and never change it. Dry runs record every step as
 * skipped (actions have side effects).
 */

export type RunRow = typeof runs.$inferSelect;

export function runView(run: RunRow): Record<string, unknown> {
  return {
    id: run.id,
    processId: run.processId,
    executorId: run.executorId,
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

/** Run the process's steps for `phase`. Returns false when a step failed. Idempotent per run. */
export async function runSteps(
  ctx: Ctx,
  phase: StepPhase,
  run: RunRow,
  process: ProcessRow,
  events: readonly Event[],
  result?: unknown,
): Promise<boolean> {
  const list = process.document[phase];
  if (list.length === 0) return true;
  const existing = await ctx.db
    .select({ status: steps.status })
    .from(steps)
    .where(and(eq(steps.runId, run.id), eq(steps.phase, phase)));
  if (existing.length > 0) return existing.every((s) => s.status !== 'error');

  const now = ctx.clock.now();
  const fns = evalFunctions(ctx, events, now);
  const sctx = stepContext({
    events: [...events],
    run: runView(run),
    ...(phase === 'after' ? { result } : {}),
  });
  let allOk = true;
  for (const [index, step] of list.entries()) {
    const record = async (status: StepStatus, args: unknown, error: string | null) => {
      await ctx.db.insert(steps).values({
        runId: run.id,
        phase,
        index,
        providerId: step.provider,
        action: step.action,
        args: args ?? null,
        status,
        error,
        at: ctx.clock.now(),
      });
    };
    if (run.dryRun) {
      await record('skipped', null, 'dry run');
      continue;
    }
    if (step.when !== undefined && step.when.trim() !== '') {
      const when = await evaluateFilter(ctx.engine, step.when, sctx, fns);
      if (!when.result) {
        await record('skipped', null, when.error !== undefined ? `when: ${when.error}` : null);
        continue;
      }
    }
    const args = await ctx.engine.evaluate(step.args, sctx, fns);
    if (!args.ok) {
      await record('error', null, `args: ${args.error}`);
      allOk = false;
      if (phase === 'before') break;
      continue;
    }
    const source = ctx.runtime.source(step.provider);
    const executor = source ? undefined : ctx.runtime.executor(step.provider);
    const act =
      source?.source.act?.bind(source.source) ?? executor?.executor.act?.bind(executor.executor);
    let status: StepStatus = 'ok';
    let error: string | null = null;
    const secretValues: string[] = [...(source?.secretValues ?? executor?.secretValues ?? [])];
    if (!act) {
      status = 'error';
      error = `provider ${step.provider} is not available or has no actions`;
    } else {
      try {
        const resolved = await resolveSecretRefs(args.value, async (ref) => {
          const value = await ctx.secrets.resolve(ref);
          secretValues.push(value);
          return value;
        });
        const res = await act(step.action, resolved);
        if (!res.ok) {
          status = 'error';
          error = res.message ?? 'action failed';
        }
      } catch (err) {
        status = 'error';
        error = errorMessage(err);
      }
    }
    // An action's error may echo what it was sent: never store a secret value.
    await record(
      status,
      args.value,
      error === null ? null : (redactSecretValues(error, secretValues) as string),
    );
    if (status === 'error') {
      allOk = false;
      if (phase === 'before') break;
    }
  }
  return allOk;
}
