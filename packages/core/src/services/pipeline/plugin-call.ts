import { resolveSecretMarkers } from '../../expr/index.js';
import { PLUGIN_CALL_TIMEOUT_MS } from '../../plugins/attribution.js';
import { errorText } from '../../util/errors.js';
import { SECOND_MS } from '../../util/time.js';
import { isTimeoutError, withTimeout } from '../../util/timeout.js';

import type { Ctx } from './context.js';

export { PLUGIN_CALL_TIMEOUT_MS } from '../../plugins/attribution.js';

/** Per `before` step, on top of its action's time limit, for evaluating `when` and args. */
export const STEP_EVAL_BUDGET_SECONDS = 10;

export function beforeStepBudgetSeconds(stepCount: number): number {
  return stepCount * (PLUGIN_CALL_TIMEOUT_MS / SECOND_MS + STEP_EVAL_BUDGET_SECONDS);
}

export type TimedCall<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * For `invoke`, which the plugin call wrapper never cuts short: its limit is per destination. A
 * plugin that returns a plain value or throws synchronously is handled too. On timeout the call
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
 * A plugin call's outcome as a value, never a rejection. Timeouts and throws were already counted
 * against the plugin by the runtime's call wrapper (`plugins/attribution.ts`).
 */
export async function callPlugin<T>(
  method: string,
  call: () => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await call() };
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
