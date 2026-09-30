import { eq, type InferSelectModel } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import type { DbOrTx } from '../db/client.js';
import { isUuid } from '../util/uuid.js';

import { notFound } from './errors.js';

type TableWithId = PgTable & { id: PgColumn };

/** The row with this id; `forUpdate` locks it for the rest of the transaction. */
export async function findById<T extends TableWithId>(
  db: DbOrTx,
  table: T,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<InferSelectModel<T> | undefined> {
  if (!isUuid(id)) return undefined;
  // Drizzle cannot select from a generic table; the row type is restored below.
  const source: PgTable = table;
  const query = db.select().from(source).where(eq(table.id, id));
  const rows = options.forUpdate ? await query.for('update') : await query;
  return rows[0] as InferSelectModel<T> | undefined;
}

/** A malformed id is as absent as an unknown one; `load` runs only for a well-formed id. */
export async function findOrThrow<T>(
  label: string,
  id: string,
  load: () => Promise<T | undefined>,
): Promise<T> {
  const row = isUuid(id) ? await load() : undefined;
  if (row === undefined) throw notFound(label);
  return row;
}

/** `findById`, refused with a 404 naming `label` (`"Process"`, `"batch <id>"`). */
export async function requireById<T extends TableWithId>(
  db: DbOrTx,
  table: T,
  id: string,
  label: string,
  options: { forUpdate?: boolean } = {},
): Promise<InferSelectModel<T>> {
  const row = await findById(db, table, id, options);
  if (row === undefined) throw notFound(label);
  return row;
}
