/**
 * Small runtime-checked accessors for webhook and API payloads. Payloads are `unknown` at the
 * boundary; these read one field at a time and yield `undefined` for anything of the wrong type.
 */

export type Json = Record<string, unknown>;

export function obj(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** Read a nested field: `path(body, 'pull_request', 'head', 'ref')`. */
export function path(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    const o = obj(current);
    if (!o) return undefined;
    current = o[key];
  }
  return current;
}

/** Parse a JSON body; `undefined` when it is not a JSON object. */
export function parseJsonObject(text: string): Json | undefined {
  try {
    return obj(JSON.parse(text));
  } catch {
    return undefined;
  }
}
