import { inArray } from 'drizzle-orm';

import type { DbOrTx } from '../../db/client.js';
import { destinations, processes, sources } from '../../db/schema.js';
import { isUuid } from '../../util/uuid.js';

const NAMED = { process: processes, source: sources, destination: destinations } as const;
export type NamedKind = keyof typeof NAMED;

const GONE: Record<NamedKind, string> = {
  process: '(deleted process)',
  source: '(deleted source)',
  destination: '(deleted destination)',
};

/** Display names by id; an id with no row reads as the given fallback, e.g. `(deleted process)`. */
export interface Names {
  of(id: string): string;
  /** Undefined when the row is gone. */
  get(id: string): string | undefined;
}

export function namesFrom(rows: readonly { id: string; name: string }[], fallback: string): Names {
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return { of: (id) => byId.get(id) ?? fallback, get: (id) => byId.get(id) };
}

/** The names of the rows with these ids, in one query. Ids that are not UUIDs have no row. */
export async function namesById(
  db: DbOrTx,
  kind: NamedKind,
  ids: Iterable<string>,
  fallback: string = GONE[kind],
): Promise<Names> {
  const unique = [...new Set(ids)].filter(isUuid);
  if (unique.length === 0) return namesFrom([], fallback);
  const table = NAMED[kind];
  const rows = await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(inArray(table.id, unique));
  return namesFrom(rows, fallback);
}
