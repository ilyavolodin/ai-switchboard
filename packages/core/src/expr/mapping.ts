import { validateAgainst, type JSONSchema } from '@ai-switchboard/sdk';

import { errorText } from '../util/errors.js';
import type { EvalFunctions, ExpressionEngine } from './engine.js';
import { replaceSecretMarkers } from './secret-markers.js';

export type MappingOutcome =
  | { ok: true; input: unknown }
  | { ok: false; input?: unknown; stage: 'evaluate' | 'validate'; errors: string[] };

/**
 * Runs before any budget is spent: an invalid input fails the run with no reservation. Secret
 * markers stay in the returned input; for validation they stand in as their `secret://` string.
 */
export async function evaluateMapping(
  engine: ExpressionEngine,
  expr: string,
  context: unknown,
  fns: EvalFunctions,
  inputSchema: JSONSchema | undefined,
): Promise<MappingOutcome> {
  const out = await engine.evaluate(expr, context, fns);
  if (!out.ok) return { ok: false, stage: 'evaluate', errors: [out.error] };
  if (out.value === undefined) {
    return { ok: false, stage: 'evaluate', errors: ['input mapping produced no value'] };
  }
  if (inputSchema !== undefined) {
    let check: { valid: boolean; errors: string[] };
    try {
      check = validateAgainst(
        inputSchema,
        replaceSecretMarkers(out.value, (ref) => ref),
      );
    } catch (err) {
      return {
        ok: false,
        input: out.value,
        stage: 'validate',
        errors: [`destination inputSchema is invalid: ${errorText(err)}`],
      };
    }
    if (!check.valid)
      return { ok: false, input: out.value, stage: 'validate', errors: check.errors };
  }
  return { ok: true, input: out.value };
}
