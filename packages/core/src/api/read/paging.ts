import { and, eq, lt, or, type AnyColumn, type SQL } from 'drizzle-orm';

import { badRequest } from '../errors.js';

/** Opaque cursors: base64url JSON of the last row's sort key. */
export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** The cursor's sort key, or null for the first page. A cursor that is not ours is a 400. */
export function decodeCursor(cursor: string | undefined): { t: string; id?: string } | null {
  if (cursor === undefined || cursor === '') return null;
  let parsed: { t?: unknown; id?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.t !== 'string') return null;
  parseTime(parsed.t, 'cursor');
  return { t: parsed.t, ...(typeof parsed.id === 'string' ? { id: parsed.id } : {}) };
}

/** An ISO time from a query string; anything `Date` cannot read is a 400, not a 500. */
export function parseTime(value: string, name: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${name} is not a valid time.`);
  return date;
}

/**
 * Keyset condition for a list sorted by `(time desc, id desc)`: rows strictly after the cursor.
 * With only a time (cursors issued before ids were added), rows sharing it are skipped.
 */
export function afterCursor(
  time: AnyColumn,
  id: AnyColumn,
  cursor: { t: string; id?: string },
): SQL {
  const t = new Date(cursor.t);
  if (cursor.id === undefined) return lt(time, t);
  return or(lt(time, t), and(eq(time, t), lt(id, cursor.id))) ?? lt(time, t);
}

export function pageLimit(limit: number | string | undefined, fallback = 50, max = 200): number {
  const n = Number(limit ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
