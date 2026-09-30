import { and, eq, lt, or, type AnyColumn, type SQL } from 'drizzle-orm';

import { isRecord } from '../../util/guards.js';
import type { Page } from '../../contract/index.js';
import { badRequest } from '../errors.js';

/** Opaque cursors: base64url JSON of the last row's sort key. */
export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

const NOT_OURS = 'cursor is not a cursor this API issued; start again without it.';

/** The cursor's sort key, or null for the first page. A cursor that is not ours is a 400. */
export function decodeCursor(cursor: string | undefined): { t: string; id?: string } | null {
  if (cursor === undefined || cursor === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badRequest(NOT_OURS);
  }
  if (!isRecord(parsed) || typeof parsed.t !== 'string') throw badRequest(NOT_OURS);
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

/** The query schema has already checked that `limit` is a positive integer. */
export function pageLimit(limit: number | undefined, fallback = 50, max = 200): number {
  return Math.min(limit ?? fallback, max);
}

export interface KeysetOrder<Row> {
  time: AnyColumn;
  id: AnyColumn;
  /** The row's sort key, as the cursor carries it. */
  keyOf(row: Row): { t: Date | null; id: string };
}

/**
 * One page of a list sorted by `(time desc, id desc)`. `fetch` runs the query with the filters
 * plus the cursor's condition, ordered that way, taking `take` rows (one more than the page, so
 * the cursor is only issued when another page exists).
 */
export async function keysetPage<Row, Item>(
  query: { cursor?: string | undefined; limit?: number | undefined },
  order: KeysetOrder<Row>,
  filters: SQL[],
  fetch: (where: SQL | undefined, take: number) => Promise<Row[]>,
  toItems: (rows: Row[]) => Promise<Item[]> | Item[],
): Promise<Page<Item>> {
  const limit = pageLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  const where = [...filters];
  if (cursor) where.push(afterCursor(order.time, order.id, cursor));
  const rows = await fetch(where.length > 0 ? and(...where) : undefined, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const key = last ? order.keyOf(last) : null;
  return {
    items: await toItems(page),
    nextCursor:
      rows.length > limit && key?.t ? encodeCursor({ t: key.t.toISOString(), id: key.id }) : null,
  };
}
