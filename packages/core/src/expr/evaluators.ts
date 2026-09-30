import type { EvalFunctions, ExpressionEngine } from './engine.js';

/** Each evaluator runs one kind of expression and turns its value (or failure) into what the
 * pipeline needs. None throws: a failure is part of the outcome. */

/** JSONata's boolean cast: empty/zero/absent are false; arrays are true when any item is. */
export function toBoolean(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.some((v) => toBoolean(v));
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

function isBlank(expr: string | undefined): expr is undefined {
  return expr === undefined || expr.trim() === '';
}

export interface FilterOutcome {
  result: boolean;
  error?: string;
}

/** No expression is `true`; any failure is `false` with the error recorded. */
export async function evaluateFilter(
  engine: ExpressionEngine,
  expr: string | undefined,
  context: unknown,
  fns: EvalFunctions,
): Promise<FilterOutcome> {
  if (isBlank(expr)) return { result: true };
  const out = await engine.evaluate(expr, context, fns);
  if (!out.ok) return { result: false, error: out.error };
  return { result: toBoolean(out.value) };
}

export interface KeyOutcome {
  key: string;
  error?: string;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** No expression (or a failure) is the default batch `''`. */
export async function evaluateBatchKey(
  engine: ExpressionEngine,
  expr: string | undefined,
  context: unknown,
  fns: EvalFunctions,
): Promise<KeyOutcome> {
  if (isBlank(expr)) return { key: '' };
  const out = await engine.evaluate(expr, context, fns);
  if (!out.ok) return { key: '', error: out.error };
  return { key: stringify(out.value) };
}

export async function renderTemplate(
  engine: ExpressionEngine,
  expr: string,
  context: unknown,
  fns: EvalFunctions,
): Promise<{ text: string; error?: string }> {
  const out = await engine.evaluate(expr, context, fns);
  if (!out.ok) return { text: '', error: out.error };
  if (typeof out.value === 'string') return { text: out.value };
  if (out.value === undefined) return { text: '' };
  return { text: JSON.stringify(out.value, null, 2) };
}
