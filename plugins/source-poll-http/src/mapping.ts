import jsonata from 'jsonata';

/** Evaluation limits, matching the core's rule that every expression has a 2 s budget. */
const TIMEOUT_MS = 2_000;
const MAX_DEPTH = 500;

/** Thrown when the mapping expression cannot be compiled or evaluated. */
export class MappingError extends Error {
  override readonly name = 'MappingError';
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    if (typeof err.message === 'string') return err.message;
  }
  return String(err);
}

/** A compiled JSONata expression with deterministic evaluation. */
export interface CompiledExpression {
  /**
   * Evaluate over `input`. `$now()` and `$millis()` return `fixedNow` (the poll's start time)
   * instead of reading the clock mid-evaluation, so every item of one poll sees the same instant.
   * `$random()` is unavailable so a mapping stays repeatable.
   */
  evaluate(input: unknown, fixedNow: string): Promise<unknown>;
}

export function compileExpression(source: string, what: string): CompiledExpression {
  let expr: jsonata.Expression;
  try {
    expr = jsonata(source, { timeout: TIMEOUT_MS, stack: MAX_DEPTH });
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
          throw new MappingError('$random() is not available: mappings must be deterministic');
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

/** A mapping result as a list: one object → [object], nothing → []. */
export function asList(result: unknown): unknown[] {
  if (result === undefined || result === null) return [];
  return Array.isArray(result) ? (result as unknown[]) : [result];
}
