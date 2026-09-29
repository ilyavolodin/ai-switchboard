import { and, asc, eq, inArray, or } from 'drizzle-orm';

import type { Event } from '@ai-switchboard/sdk';

import type { DbOrTx } from '../../db/client.js';
import { batches, dispatches, events } from '../../db/schema.js';

import { toEvent, type BatchRow } from './views.js';

/**
 * Includes events of event batches a sweep merged and, for a manual test run, of the batch it
 * replays.
 */
export async function batchEvents(db: DbOrTx, batch: BatchRow): Promise<Event[]> {
  const roots = [batch.id, ...(batch.eventsFrom !== null ? [batch.eventsFrom] : [])];
  const merged = await db
    .select({ id: batches.id })
    .from(batches)
    .where(inArray(batches.mergedInto, roots));
  const ids = [...roots, ...merged.map((m) => m.id)];
  const rows = await db
    .select({ event: events })
    .from(dispatches)
    .innerJoin(events, eq(events.id, dispatches.eventId))
    .where(and(inArray(dispatches.batchId, ids), eq(dispatches.outcome, 'batched')))
    .orderBy(asc(events.occurredAt), asc(events.receivedAt));
  const seen = new Set<string>();
  const out: Event[] = [];
  for (const r of rows) {
    if (seen.has(r.event.id)) continue;
    seen.add(r.event.id);
    out.push(toEvent(r.event));
  }
  return out;
}

/** Batches whose events include `batchIds` directly or by merge (for the trace). */
export async function relatedBatchIds(db: DbOrTx, batchIds: readonly string[]): Promise<string[]> {
  if (batchIds.length === 0) return [];
  const rows = await db
    .select({ id: batches.id, mergedInto: batches.mergedInto })
    .from(batches)
    .where(or(inArray(batches.id, [...batchIds]), inArray(batches.eventsFrom, [...batchIds])));
  const out = new Set<string>(batchIds);
  for (const r of rows) {
    out.add(r.id);
    if (r.mergedInto !== null) out.add(r.mergedInto);
  }
  return [...out];
}
