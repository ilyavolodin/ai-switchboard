import { isOneOf } from '@ai-switchboard/sdk';
import { desc, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';

import type { ActivityQuery, ActivityRow, EventDetail, Page } from '../../contract/index.js';
import { batches, dispatches, eventRaw, events, processes, runs } from '../../db/schema.js';
import { EVENT_STAGES } from '../../domain/status.js';
import { explanationsFor } from '../../services/explain.js';
import { groupBy } from '../../util/collections.js';
import { summarizeWhy } from '../../views/explain.js';
import { notFound } from '../errors.js';
import { activityRow, rawPreview, type DispatchInfo, type EventRow } from './activity.shape.js';
import type { ReadDeps } from './deps.js';
import { namesById } from './names.js';
import { keysetPage, parseTime } from './paging.js';

async function dispatchesFor(
  deps: ReadDeps,
  eventIds: string[],
): Promise<Map<string, DispatchInfo[]>> {
  if (eventIds.length === 0) return new Map();
  const rows = await deps.db
    .select({
      eventId: dispatches.eventId,
      processId: dispatches.processId,
      processName: processes.name,
      outcome: dispatches.outcome,
      batchOutcome: batches.outcome,
      batchReason: batches.outcomeReason,
      runId: runs.id,
      runStatus: runs.status,
    })
    .from(dispatches)
    .leftJoin(processes, eq(processes.id, dispatches.processId))
    .leftJoin(batches, eq(batches.id, dispatches.batchId))
    .leftJoin(runs, or(eq(runs.batchId, dispatches.batchId), eq(runs.batchId, batches.mergedInto)))
    .where(inArray(dispatches.eventId, eventIds));
  const out = new Map<string, DispatchInfo[]>();
  for (const [eventId, list] of groupBy(rows, (r) => r.eventId)) {
    out.set(
      eventId,
      list.map((r) => ({
        processId: r.processId,
        processName: r.processName ?? '(deleted process)',
        outcome: r.outcome,
        batchOutcome: r.batchOutcome,
        batchReason: r.batchReason,
        runId: r.runId,
        runStatus: r.runStatus,
      })),
    );
  }
  return out;
}

export async function activityRows(deps: ReadDeps, rows: EventRow[]): Promise<ActivityRow[]> {
  const [dispatched, why, sourceNames] = await Promise.all([
    dispatchesFor(
      deps,
      rows.map((r) => r.id),
    ),
    explanationsFor(
      deps.db,
      rows.filter((r) => r.stage === 'unmatched'),
    ),
    namesById(
      deps.db,
      'source',
      rows.map((r) => r.sourceId),
    ),
  ]);
  return rows.map((e) =>
    activityRow(
      e,
      dispatched.get(e.id) ?? [],
      sourceNames.of(e.sourceId),
      summarizeWhy(e.stage, why.get(e.id) ?? []),
    ),
  );
}

/** Match an artifact query: exact id, `kind:id`, or a suffix such as `#482`. */
export function artifactCondition(query: string): SQL {
  const q = query.trim();
  const colon = q.indexOf(':');
  if (colon > 0 && !q.startsWith('#')) {
    const kind = q.slice(0, colon);
    const id = q.slice(colon + 1);
    if (kind.includes('.')) return eq(events.artifactKey, `${kind}:${id}`);
  }
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return (
    or(
      sql`${events.artifact}->>'id' = ${q}`,
      sql`${events.artifact}->>'id' ILIKE ${`%${escaped}`}`,
    ) ?? sql`false`
  );
}

function activityFilters(deps: ReadDeps, q: ActivityQuery): SQL[] {
  const where: SQL[] = [];
  if (q.source) where.push(eq(events.sourceId, q.source));
  if (q.stage) {
    const stages = q.stage.split(',').filter((s) => isOneOf(EVENT_STAGES, s));
    where.push(inArray(events.stage, stages));
  }
  if (q.type) where.push(eq(events.type, q.type));
  if (q.artifact) where.push(artifactCondition(q.artifact));
  if (q.from) where.push(gte(events.receivedAt, parseTime(q.from, 'from')));
  if (q.to) where.push(lte(events.receivedAt, parseTime(q.to, 'to')));
  if (q.process) {
    where.push(
      inArray(
        events.id,
        deps.db
          .select({ id: dispatches.eventId })
          .from(dispatches)
          .where(eq(dispatches.processId, q.process)),
      ),
    );
  }
  if (q.destination) {
    where.push(
      inArray(
        events.id,
        deps.db
          .select({ id: dispatches.eventId })
          .from(dispatches)
          .leftJoin(batches, eq(batches.id, dispatches.batchId))
          .innerJoin(
            runs,
            or(eq(runs.batchId, dispatches.batchId), eq(runs.batchId, batches.mergedInto)),
          )
          .where(eq(runs.destinationId, q.destination)),
      ),
    );
  }
  return where;
}

export async function listActivity(deps: ReadDeps, q: ActivityQuery): Promise<Page<ActivityRow>> {
  return keysetPage(
    q,
    {
      time: events.receivedAt,
      id: events.id,
      keyOf: (r: EventRow) => ({ t: r.receivedAt, id: r.id }),
    },
    activityFilters(deps, q),
    (cond, take) =>
      deps.db
        .select()
        .from(events)
        .where(cond)
        .orderBy(desc(events.receivedAt), desc(events.id))
        .limit(take),
    (rows) => activityRows(deps, rows),
  );
}

/** Whether an event row exists (a replay of a pruned or unknown event is a 404). */
export async function eventExists(deps: ReadDeps, id: string): Promise<boolean> {
  const rows = await deps.db.select({ id: events.id }).from(events).where(eq(events.id, id));
  return rows.length > 0;
}

export async function eventDetail(deps: ReadDeps, id: string): Promise<EventDetail> {
  const [row] = await deps.db.select().from(events).where(eq(events.id, id));
  if (!row) throw notFound('Event');
  const [[activity], [raw], explanations] = await Promise.all([
    activityRows(deps, [row]),
    deps.db.select().from(eventRaw).where(eq(eventRaw.ref, row.rawRef)),
    explanationsFor(deps.db, [row]),
  ]);
  if (!activity) throw notFound('Event');
  return {
    ...activity,
    attributes: row.attributes,
    dedupeKey: row.dedupeKey,
    deliveryId: row.deliveryId,
    stageReason: row.stageReason,
    explanations: explanations.get(row.id) ?? [],
    raw: raw ? rawPreview(raw) : null,
  };
}
