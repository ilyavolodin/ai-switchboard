import type { Event } from '@ai-switchboard/sdk';

import type { EvalFunctions, ExpressionEngine } from './engine.js';

/**
 * The evaluation contexts from the TDD, and the typed wrappers each use site calls. Every wrapper
 * turns an engine failure into a value the pipeline can use (a filter error is `false`), plus the
 * error text to record.
 */

/** A filter and a batch key see `{ event, process, now }`; the event's fields are also top-level. */
export function filterContext(
  event: Event,
  process: Record<string, unknown> | null,
  now: Date,
): Record<string, unknown> {
  // Spreading the event lets the TDD's short form work: `attributes.label = 'x'`.
  return { ...event, event, process, now: now.toISOString() };
}

export interface RunContext {
  id: string;
  dryRun: boolean;
  mode: 'event' | 'sweep' | 'manual';
  processId: string;
  processName: string;
  callbackUrl?: string;
  deadline?: string;
}

/** The input mapping sees `{ events, process, run, mode }`. */
export function mappingContext(input: {
  events: Event[];
  process: Record<string, unknown>;
  run: RunContext;
  mode: 'event' | 'sweep';
}): Record<string, unknown> {
  return { events: input.events, process: input.process, run: input.run, mode: input.mode };
}

/** Step arguments and conditions see `{ events, run, result }` (`result` only in `after`). */
export function stepContext(input: {
  events: Event[];
  run: Record<string, unknown>;
  result?: unknown;
}): Record<string, unknown> {
  return {
    events: input.events,
    run: input.run,
    ...(input.result !== undefined ? { result: input.result } : {}),
  };
}

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

export interface FilterOutcome {
  result: boolean;
  error?: string;
}

/** A filter: no expression is `true`; any failure is `false` with the error recorded. */
export async function evaluateFilter(
  engine: ExpressionEngine,
  expr: string | undefined,
  context: unknown,
  fns: EvalFunctions,
): Promise<FilterOutcome> {
  if (expr === undefined || expr.trim() === '') return { result: true };
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

/** A batch key: no expression (or a failure) is the default batch `''`. */
export async function evaluateBatchKey(
  engine: ExpressionEngine,
  expr: string | undefined,
  context: unknown,
  fns: EvalFunctions,
): Promise<KeyOutcome> {
  if (expr === undefined || expr.trim() === '') return { key: '' };
  const out = await engine.evaluate(expr, context, fns);
  if (!out.ok) return { key: '', error: out.error };
  return { key: stringify(out.value) };
}

/** A notification template renders to text; objects are pretty-printed JSON. */
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
