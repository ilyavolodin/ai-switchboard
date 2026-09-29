import { eq, sql, type SQL } from 'drizzle-orm';

import type { Db, DbOrTx, Tx } from '../../db/client.js';
import { batches, type GateDecisionRecord } from '../../db/schema.js';

import type { BatchRow } from './views.js';

const RETRYABLE_PG_CODES = new Set(['23505', '40001', '40P01']);

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 3 && e !== null && typeof e === 'object'; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Retries on unique violations, serialization failures and deadlocks: a racing replica won, and
 * the retry re-reads and usually no-ops.
 */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await db.transaction(fn);
    } catch (err) {
      const code = pgCode(err);
      if (i >= attempts || code === undefined || !RETRYABLE_PG_CODES.has(code)) throw err;
    }
  }
}

export async function lockKey(tx: DbOrTx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export function appendDecisions(records: readonly GateDecisionRecord[]): SQL {
  return sql`${batches.decisions} || ${JSON.stringify(records)}::jsonb`;
}

export async function lockBatch(tx: Tx, batchId: string): Promise<BatchRow | undefined> {
  const [row] = await tx.select().from(batches).where(eq(batches.id, batchId)).for('update');
  return row;
}

/** Locks the batch; `undefined` when another worker already moved it on from `closed`. */
export async function lockClosedBatch(tx: Tx, batchId: string): Promise<BatchRow | undefined> {
  const row = await lockBatch(tx, batchId);
  return row?.outcome === 'closed' ? row : undefined;
}
