/**
 * The JSONata sandbox for plugins that let a person write expressions
 * (`@ai-switchboard/sdk/jsonata`). `jsonata` is an optional peer dependency: a plugin that
 * imports this subpath lists `jsonata` in its own dependencies.
 */
import jsonata from 'jsonata';

import { errorText, isRecord } from './json.js';

/** Every evaluation's limit, matching the core's 2 s rule for expressions. */
export const EXPRESSION_TIMEOUT_MS = 2_000;
export const EXPRESSION_MAX_DEPTH = 500;

export class MappingError extends Error {
  override readonly name = 'MappingError';
}

/** JSONata throws plain objects (`{ code, message, position }`) as well as `Error`s. */
function describe(err: unknown): string {
  if (isRecord(err) && typeof err.message === 'string') return err.message;
  return errorText(err);
}

export interface CompiledExpression {
  /**
   * Evaluate over `input`. `$now()` and `$millis()` return `fixedNow` instead of reading the
   * clock, so the same input always gives the same result; `$random()` throws for the same
   * reason. The result is plain JSON data (or `undefined`). Failures throw `MappingError`.
   */
  evaluate(input: unknown, fixedNow: string): Promise<unknown>;
}

/** Throws `MappingError` when `source` does not compile; `what` names it in messages. */
export function compileExpression(source: string, what: string): CompiledExpression {
  let expr: jsonata.Expression;
  try {
    expr = jsonata(source, { timeout: EXPRESSION_TIMEOUT_MS, stack: EXPRESSION_MAX_DEPTH });
  } catch (err) {
    throw new MappingError(`${what} does not compile: ${describe(err)}`);
  }
  return {
    async evaluate(input, fixedNow) {
      const millis = Date.parse(fixedNow);
      const bindings = {
        now: () => fixedNow,
        millis: () => millis,
        random: () => {
          throw new MappingError('$random() is not available: expressions must be deterministic');
        },
      };
      let result: unknown;
      try {
        result = await expr.evaluate(input, bindings);
      } catch (err) {
        throw new MappingError(`${what} failed: ${describe(err)}`);
      }
      // JSONata returns sequences (arrays with extra flags) and may include functions; a JSON
      // round trip leaves plain data only.
      return result === undefined ? undefined : (JSON.parse(JSON.stringify(result)) as unknown);
    },
  };
}

/** An expression result as a list: nothing for `undefined`/`null`, a single value wrapped. */
export function asList(result: unknown): unknown[] {
  if (result === undefined || result === null) return [];
  return Array.isArray(result) ? (result as unknown[]) : [result];
}
