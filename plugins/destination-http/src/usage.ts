import {
  asObject,
  errorText,
  pickDeclaredUsage,
  type HttpResponse,
  type Logger,
  type UsageReport,
} from '@ai-switchboard/sdk';
import {
  compileExpression,
  MappingError,
  type CompiledExpression,
} from '@ai-switchboard/sdk/jsonata';

import type { HttpTarget } from './target.js';

export interface SyncResponse {
  res: HttpResponse;
  body: unknown;
  durationSeconds: number;
}

export interface UsageMeasurer {
  /** Measured and `usageFrom` usage in declared dimensions; never throws. */
  measure(target: HttpTarget, response: SyncResponse, now: Date): Promise<UsageReport | undefined>;
}

export function createUsageMeasurer(declared: ReadonlySet<string>, logger: Logger): UsageMeasurer {
  // Compiled per instance: the set of expressions is bounded by this instance's targets.
  const compiled = new Map<string, CompiledExpression>();
  function expression(source: string): CompiledExpression {
    let expr = compiled.get(source);
    if (!expr) {
      expr = compileExpression(source, 'usageFrom');
      compiled.set(source, expr);
    }
    return expr;
  }

  return {
    async measure(target, { res, body, durationSeconds }, now) {
      const measured: Record<string, unknown> = {
        duration_seconds: durationSeconds,
        response_bytes: res.body.length,
      };
      if (target.usageFrom !== undefined) {
        try {
          const value = await expression(target.usageFrom).evaluate(
            { response: { status: res.status, headers: res.headers, body }, durationSeconds },
            now.toISOString(),
          );
          const fromExpr = asObject(value);
          if (!fromExpr) {
            throw new MappingError('usageFrom must return an object of dimension id → number');
          }
          Object.assign(measured, fromExpr);
        } catch (err) {
          // The work already happened; a broken usage expression must not fail the run.
          logger.warn('usageFrom evaluation failed', { error: errorText(err) });
        }
      }
      return pickDeclaredUsage(measured, declared);
    },
  };
}
