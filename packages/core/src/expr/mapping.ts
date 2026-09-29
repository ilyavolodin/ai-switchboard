import { validateAgainst, type JSONSchema } from '@ai-switchboard/sdk';

import type { EvalFunctions, ExpressionEngine } from './engine.js';
import { replaceSecretRefs } from './engine.js';

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
        replaceSecretRefs(out.value, (ref) => ref),
      );
    } catch (err) {
      return {
        ok: false,
        input: out.value,
        stage: 'validate',
        errors: [
          `destination inputSchema is invalid: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }
    if (!check.valid)
      return { ok: false, input: out.value, stage: 'validate', errors: check.errors };
  }
  return { ok: true, input: out.value };
}
