/** Browser-safe (`@ai-switchboard/sdk/json`): no Node imports belong here. */
import type { HttpResponse } from './http.js';

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Finite numbers only. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** A non-array gives `[]`. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** `getPath(body, 'issue', 'labels')`; `undefined` as soon as a step is not an object. */
export function getPath(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    const o = asObject(current);
    if (!o) return undefined;
    current = o[key];
  }
  return current;
}

/** `undefined` for invalid JSON or a non-object. */
export function parseJsonObject(text: string): JsonObject | undefined {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The response body as JSON, or `undefined` when it is empty or not JSON (a proxy page, a 204). */
export function tryJson(res: HttpResponse): unknown {
  try {
    return res.json();
  } catch {
    return undefined;
  }
}
