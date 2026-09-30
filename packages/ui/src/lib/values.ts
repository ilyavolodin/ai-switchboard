import { isPlainObject } from './json.js';

export function parseNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** So untouched caps are not sent. */
export function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Deep equality that ignores key order and `undefined` keys. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, normalize(x)]),
    );
  }
  return v;
}

export function asRecord(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}
