import { eq } from 'drizzle-orm';

import type { Tx } from '../../db/client.js';
import { batches } from '../../db/schema.js';

import type { BatchRow } from './views.js';

type BatchInsert = typeof batches.$inferInsert;

export async function lockBatch(tx: Tx, batchId: string): Promise<BatchRow | undefined> {
  const [row] = await tx.select().from(batches).where(eq(batches.id, batchId)).for('update');
  return row;
}

/** Locks the batch; `undefined` when another worker already moved it on from `closed`. */
export async function lockClosedBatch(tx: Tx, batchId: string): Promise<BatchRow | undefined> {
  const row = await lockBatch(tx, batchId);
  return row?.outcome === 'closed' ? row : undefined;
}

/** A manual or sweep batch: opened, closed and due at `now`, ready for dispatch. */
export async function insertClosedBatch(
  tx: Tx,
  now: Date,
  values: Pick<BatchInsert, 'id' | 'processId' | 'batchKey' | 'kind' | 'size' | 'decisions'> &
    Partial<Pick<BatchInsert, 'dryRun' | 'requestedBy' | 'eventsFrom' | 'scheduleId' | 'tickAt'>>,
): Promise<void> {
  await tx
    .insert(batches)
    .values({ ...values, openedAt: now, fireAfter: now, closedAt: now, outcome: 'closed' });
}
