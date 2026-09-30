import { desc, eq, inArray, or, sql } from 'drizzle-orm';

import type { ArtifactRef } from '@ai-switchboard/sdk';

import type { TraceResponse } from '../contract/index.js';
import type { Db } from '../db/client.js';
import {
  approvals,
  batches,
  dispatches,
  events,
  destinations,
  notificationLog,
  processes,
  runUpdates,
  runs,
  steps,
} from '../db/schema.js';
import type { Deps } from '../deps.js';
import { isUuid } from '../util/uuid.js';
import { renderTraceText, traceEntries, type TraceData } from '../views/trace.js';
import { explanationsFor } from './explain.js';
import { relatedBatchIds } from './pipeline/load.js';

type EventRow = typeof events.$inferSelect;

const MAX_EVENTS = 200;

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Events for a query: an event id, an exact artifact id, `kind:id`, or an id suffix (`#482`). */
async function findEvents(deps: Deps, query: string): Promise<EventRow[]> {
  const q = query.trim();
  if (q === '') return [];
  if (isUuid(q)) {
    const byId = await deps.db.select().from(events).where(eq(events.id, q));
    if (byId.length > 0) return byId;
  }
  const idExpr = sql`(${events.artifact}->>'id')`;
  const suffixes = [q];
  if (/^\d+$/.test(q)) suffixes.push(`#${q}`, `/${q}`);
  const conditions = [
    sql`${idExpr} = ${q}`,
    eq(events.artifactKey, q),
    ...suffixes.map((s) => sql`${idExpr} LIKE ${`%${likeEscape(s)}`}`),
  ];
  if (q.startsWith('#')) conditions.push(sql`${idExpr} = ${q.slice(1)}`);
  return deps.db
    .select()
    .from(events)
    .where(or(...conditions))
    .orderBy(desc(events.receivedAt))
    .limit(MAX_EVENTS);
}

export async function traceForArtifact(deps: Deps, query: string): Promise<TraceResponse> {
  return buildTrace(deps, query, await findEvents(deps, query));
}

export async function traceForEvent(deps: Deps, eventId: string): Promise<TraceResponse> {
  const rows = isUuid(eventId)
    ? await deps.db.select().from(events).where(eq(events.id, eventId))
    : [];
  return buildTrace(deps, eventId, rows);
}

/** `select … where column in ids`, skipped when there are none. */
function whereIn<T>(ids: readonly string[], load: (ids: string[]) => Promise<T[]>): Promise<T[]> {
  return ids.length > 0 ? load([...ids]) : Promise.resolve([]);
}

/** Everything the events led to: dispatches, batches (merged ones too), runs and their rows. */
export async function loadTraceData(db: Db, eventRows: EventRow[]): Promise<TraceData> {
  const eventIds = eventRows.map((e) => e.id);
  const disp = await whereIn(eventIds, (ids) =>
    db.select().from(dispatches).where(inArray(dispatches.eventId, ids)),
  );
  const batchIds = await relatedBatchIds(db, [
    ...new Set(disp.flatMap((d) => (d.batchId !== null ? [d.batchId] : []))),
  ]);
  const [batchRows, runRows, approvalRows] = await Promise.all([
    whereIn(batchIds, (ids) => db.select().from(batches).where(inArray(batches.id, ids))),
    whereIn(batchIds, (ids) => db.select().from(runs).where(inArray(runs.batchId, ids))),
    whereIn(batchIds, (ids) => db.select().from(approvals).where(inArray(approvals.batchId, ids))),
  ]);
  const runIds = runRows.map((r) => r.id);
  const processIds = [
    ...new Set([
      ...disp.map((d) => d.processId),
      ...batchRows.map((b) => b.processId),
      ...eventRows.flatMap((e) => e.matchDecisions.map((m) => m.processId)),
    ]),
  ];
  const destinationIds = [...new Set(runRows.map((r) => r.destinationId))];
  const [updates, stepRows, notes, procRows, exRows, explanations] = await Promise.all([
    whereIn(runIds, (ids) => db.select().from(runUpdates).where(inArray(runUpdates.runId, ids))),
    whereIn(runIds, (ids) => db.select().from(steps).where(inArray(steps.runId, ids))),
    whereIn(batchIds, (ids) =>
      db
        .select()
        .from(notificationLog)
        .where(
          or(
            inArray(notificationLog.batchId, ids),
            ...(runIds.length > 0 ? [inArray(notificationLog.runId, runIds)] : []),
          ),
        ),
    ),
    whereIn(processIds, (ids) =>
      db
        .select({ id: processes.id, name: processes.name })
        .from(processes)
        .where(inArray(processes.id, ids)),
    ),
    whereIn(destinationIds, (ids) =>
      db
        .select({ id: destinations.id, name: destinations.name })
        .from(destinations)
        .where(inArray(destinations.id, ids)),
    ),
    explanationsFor(db, eventRows),
  ]);
  return {
    events: eventRows,
    dispatches: disp,
    batches: batchRows,
    runs: runRows,
    updates,
    steps: stepRows,
    approvals: approvalRows,
    notifications: notes,
    processNames: new Map(procRows.map((p) => [p.id, p.name])),
    destinationNames: new Map(exRows.map((e) => [e.id, e.name])),
    explanations,
  };
}

async function buildTrace(
  deps: Deps,
  query: string,
  eventRows: EventRow[],
): Promise<TraceResponse> {
  if (eventRows.length === 0)
    return { query, artifacts: [], entries: [], text: `No events found for ${query}.` };
  const artifacts = new Map<string, ArtifactRef>();
  for (const e of eventRows) artifacts.set(e.artifactKey, e.artifact);
  const entries = traceEntries(await loadTraceData(deps.db, eventRows));
  return {
    query,
    artifacts: [...artifacts.values()],
    entries,
    text: renderTraceText(query, entries),
  };
}
