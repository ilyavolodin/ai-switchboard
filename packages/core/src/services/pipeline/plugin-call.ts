import { resolveSecretMarkers } from '../../expr/index.js';
import { errorText } from '../../util/errors.js';
import { SECOND_MS } from '../../util/time.js';
import { isTimeoutError, withTimeout } from '../../util/timeout.js';

import type { Ctx } from './context.js';

/** Not for invoke, which has its own per-destination limit (`effectiveInvokeTimeoutSeconds`). */
export const PLUGIN_CALL_TIMEOUT_MS = 45_000;

/** Per `before` step, on top of its action's time limit, for evaluating `when` and args. */
export const STEP_EVAL_BUDGET_SECONDS = 10;

export function beforeStepBudgetSeconds(
  ctx: Pick<Ctx, 'pluginCallTimeoutMs'>,
  stepCount: number,
): number {
  const perStep = (ctx.pluginCallTimeoutMs ?? PLUGIN_CALL_TIMEOUT_MS) / SECOND_MS;
  return stepCount * (perStep + STEP_EVAL_BUDGET_SECONDS);
}

export type TimedCall<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * A plugin that returns a plain value or throws synchronously is handled too. On timeout the call
 * keeps running and its result is ignored.
 */
export async function timedCall<T>(ms: number, call: () => Promise<T> | T): Promise<TimedCall<T>> {
  try {
    const value = await withTimeout(Promise.resolve().then(call), ms, `timed out after ${ms} ms`);
    return { timedOut: false, value };
  } catch (err) {
    if (isTimeoutError(err)) return { timedOut: true };
    throw err;
  }
}

/**
 * A timeout is counted against the plugin here; a throw was already counted by the runtime's
 * attribution wrapper. Either way the failure comes back as a value, never a rejection.
 */
export async function callPlugin<T>(
  ctx: Pick<Ctx, 'runtime' | 'pluginCallTimeoutMs'>,
  pluginName: string,
  method: string,
  call: () => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const ms = ctx.pluginCallTimeoutMs ?? PLUGIN_CALL_TIMEOUT_MS;
  try {
    const out = await timedCall(ms, call);
    if (!out.timedOut) return { ok: true, value: out.value };
    const error = `${method}: timed out after ${ms} ms`;
    ctx.runtime.recordPluginError(pluginName, 'exception', error);
    return { ok: false, error };
  } catch (err) {
    return { ok: false, error: `${method}: ${errorText(err)}` };
  }
}

/**
 * Resolves `$secretRef` markers right before a plugin call. `secretValues` (the instance's own
 * plus the resolved ones) is what the caller redacts from anything it stores afterwards.
 */
export async function resolveForPluginCall(
  ctx: Pick<Ctx, 'secrets'>,
  value: unknown,
  instanceSecrets: readonly string[] = [],
): Promise<{ value: unknown; secretValues: string[] }> {
  const out = await resolveSecretMarkers(value, (ref) => ctx.secrets.resolve(ref));
  return { value: out.value, secretValues: [...instanceSecrets, ...out.secrets] };
}
