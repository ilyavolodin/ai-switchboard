import { inArray } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { dispatches, processes, type events } from '../db/schema.js';
import { explainEvent, type Explanation } from '../pipeline/explain.js';

type EventRow = typeof events.$inferSelect;

export async function explanationsFor(
  db: Db,
  rows: readonly EventRow[],
): Promise<Map<string, Explanation[]>> {
  const out = new Map<string, Explanation[]>();
  const pending = rows.filter((r) => r.stage !== 'received');
  if (pending.length === 0) return out;
  const [procRows, disp] = await Promise.all([
    db
      .select({
        id: processes.id,
        name: processes.name,
        enabled: processes.enabled,
        document: processes.document,
        createdAt: processes.createdAt,
      })
      .from(processes),
    db
      .select({
        eventId: dispatches.eventId,
        processId: dispatches.processId,
        outcome: dispatches.outcome,
      })
      .from(dispatches)
      .where(
        inArray(
          dispatches.eventId,
          pending.map((r) => r.id),
        ),
      ),
  ]);
  for (const r of pending) {
    out.set(
      r.id,
      explainEvent({
        event: {
          sourceId: r.sourceId,
          type: r.type,
          stage: r.stage,
          stageReason: r.stageReason,
          receivedAt: r.receivedAt,
        },
        decisions: r.matchDecisions,
        dispatches: disp.filter((d) => d.eventId === r.id),
        processes: procRows,
      }),
    );
  }
  return out;
}
