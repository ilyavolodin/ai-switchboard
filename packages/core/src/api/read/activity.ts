import { and, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';

import {
  batches,
  dispatches,
  eventRaw,
  events,
  processes,
  runs,
  sources,
} from '../../db/schema.js';
import type { BatchOutcome, RunStatusValue } from '../../domain/status.js';
import type { ApiContext } from '../context.js';
import type { ActivityQuery, ActivityRow, EventDetail, Page, StageIndicator } from '../contract.js';
import { notFound } from '../errors.js';
import { decodeCursor, encodeCursor, pageLimit } from './paging.js';

type EventRow = typeof events.$inferSelect;

interface DispatchInfo {
  processId: string;
  processName: string;
  outcome: string;
  batchOutcome: BatchOutcome | null;
  batchReason: string | null;
  runId: string | null;
  runStatus: RunStatusValue | null;
}

const DOOR_STOPS: Record<string, StageIndicator> = {
  unmatched: { reached: 1, tone: 'off', label: 'no process wants it' },
  source_disabled: { reached: 1, tone: 'off', label: 'source disabled' },
  source_throttled: { reached: 1, tone: 'warn', label: 'source throttled' },
  type_muted: { reached: 1, tone: 'off', label: 'type muted' },
  event_invalid: { reached: 1, tone: 'error', label: 'invalid event' },
  received: { reached: 1, tone: 'ok', label: 'received' },
};

/** How far an event got: received → matched → batched → gated → invoked, and in what tone. */
export function indicatorFor(stage: string, ds: DispatchInfo[]): StageIndicator {
  if (ds.length === 0) return DOOR_STOPS[stage] ?? { reached: 1, tone: 'ok', label: stage };
  const rank = (d: DispatchInfo): StageIndicator => {
    if (d.outcome === 'deduped') return { reached: 2, tone: 'off', label: 'deduped' };
    if (d.outcome === 'filter_error') return { reached: 2, tone: 'error', label: 'filter error' };
    if (d.runStatus) {
      const tone =
        d.runStatus === 'ok' || d.runStatus === 'running' || d.runStatus === 'invoking'
          ? 'ok'
          : d.runStatus === 'uncertain' || d.runStatus === 'unknown' || d.runStatus === 'held'
            ? 'warn'
            : 'error';
      return { reached: 5, tone, label: d.runStatus };
    }
    switch (d.batchOutcome) {
      case 'held':
        return {
          reached: 3,
          tone: 'warn',
          label: `held${d.batchReason ? ` · ${d.batchReason}` : ''}`,
        };
      case 'throttled':
        return {
          reached: 3,
          tone: 'warn',
          label: `throttled${d.batchReason ? ` · ${d.batchReason}` : ''}`,
        };
      case 'awaiting_approval':
        return { reached: 3, tone: 'warn', label: 'awaiting approval' };
      case 'rejected':
        return { reached: 3, tone: 'off', label: 'rejected' };
      case 'invoked':
      case 'merged':
        return { reached: 4, tone: 'ok', label: 'gated' };
      case null:
      case 'open':
      case 'closed':
        return { reached: 3, tone: 'ok', label: 'batched' };
    }
  };
  // Show the furthest-reaching dispatch; on a tie, the worse tone.
  const toneRank = { error: 3, warn: 2, ok: 1, off: 0 } as const;
  return (
    ds
      .map(rank)
      .sort((a, b) => b.reached - a.reached || toneRank[b.tone] - toneRank[a.tone])[0] ?? {
      reached: 1,
      tone: 'ok',
      label: 'received',
    }
  );
}

async function dispatchesFor(
  ctx: ApiContext,
  eventIds: string[],
): Promise<Map<string, DispatchInfo[]>> {
  const out = new Map<string, DispatchInfo[]>();
  if (eventIds.length === 0) return out;
  const rows = await ctx.db
    .select({
      eventId: dispatches.eventId,
      processId: dispatches.processId,
      processName: processes.name,
      outcome: dispatches.outcome,
      batchOutcome: batches.outcome,
      batchReason: batches.outcomeReason,
      mergedInto: batches.mergedInto,
      runId: runs.id,
      runStatus: runs.status,
    })
    .from(dispatches)
    .leftJoin(processes, eq(processes.id, dispatches.processId))
    .leftJoin(batches, eq(batches.id, dispatches.batchId))
    .leftJoin(runs, or(eq(runs.batchId, dispatches.batchId), eq(runs.batchId, batches.mergedInto)))
    .where(inArray(dispatches.eventId, eventIds));
  for (const r of rows) {
    const list = out.get(r.eventId) ?? [];
    list.push({
      processId: r.processId,
      processName: r.processName ?? '(deleted process)',
      outcome: r.outcome,
      batchOutcome: r.batchOutcome,
      batchReason: r.batchReason,
      runId: r.runId,
      runStatus: r.runStatus,
    });
    out.set(r.eventId, list);
  }
  return out;
}

export async function activityRows(ctx: ApiContext, rows: EventRow[]): Promise<ActivityRow[]> {
  const ds = await dispatchesFor(
    ctx,
    rows.map((r) => r.id),
  );
  const srcIds = [...new Set(rows.map((r) => r.sourceId))];
  const srcs =
    srcIds.length > 0
      ? await ctx.db
          .select({ id: sources.id, name: sources.name })
          .from(sources)
          .where(inArray(sources.id, srcIds))
      : [];
  return rows.map((e) => {
    const list = ds.get(e.id) ?? [];
    return {
      eventId: e.id,
      sourceId: e.sourceId,
      sourceName: srcs.find((s) => s.id === e.sourceId)?.name ?? '(deleted source)',
      type: e.type,
      occurredAt: e.occurredAt.toISOString(),
      receivedAt: e.receivedAt.toISOString(),
      artifact: e.artifact,
      stage: e.stage,
      indicator: indicatorFor(e.stage, list),
      processes: list.map((d) => ({
        id: d.processId,
        name: d.processName,
        outcome: d.batchOutcome ?? d.outcome,
        runId: d.runId,
        runStatus: d.runStatus,
      })),
      replayOf: e.replayOf,
    };
  });
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

export async function listActivity(ctx: ApiContext, q: ActivityQuery): Promise<Page<ActivityRow>> {
  const limit = pageLimit(q.limit);
  const cursor = decodeCursor(q.cursor);
  const where: SQL[] = [];
  if (q.source) where.push(eq(events.sourceId, q.source));
  if (q.stage) where.push(inArray(events.stage, q.stage.split(',') as EventRow['stage'][]));
  if (q.artifact) where.push(artifactCondition(q.artifact));
  if (q.from) where.push(gte(events.receivedAt, new Date(q.from)));
  if (q.to) where.push(lte(events.receivedAt, new Date(q.to)));
  if (q.process) {
    where.push(
      inArray(
        events.id,
        ctx.db
          .select({ id: dispatches.eventId })
          .from(dispatches)
          .where(eq(dispatches.processId, q.process)),
      ),
    );
  }
  if (q.executor) {
    where.push(
      inArray(
        events.id,
        ctx.db
          .select({ id: dispatches.eventId })
          .from(dispatches)
          .innerJoin(runs, eq(runs.batchId, dispatches.batchId))
          .where(eq(runs.executorId, q.executor)),
      ),
    );
  }
  if (cursor) {
    const t = new Date(cursor.t);
    where.push(
      cursor.id
        ? (or(lt(events.receivedAt, t), and(eq(events.receivedAt, t), lt(events.id, cursor.id))) ??
            sql`true`)
        : lt(events.receivedAt, t),
    );
  }
  const rows = await ctx.db
    .select()
    .from(events)
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(events.receivedAt), desc(events.id))
    .limit(limit + 1);
  const items = await activityRows(ctx, rows.slice(0, limit));
  const last = rows[limit - 1];
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ t: last.receivedAt.toISOString(), id: last.id })
        : null,
  };
}

const RAW_LIMIT = 64 * 1024;

export async function eventDetail(ctx: ApiContext, id: string): Promise<EventDetail> {
  const [row] = await ctx.db.select().from(events).where(eq(events.id, id));
  if (!row) throw notFound('Event');
  const [activity] = await activityRows(ctx, [row]);
  if (!activity) throw notFound('Event');
  const [raw] = await ctx.db.select().from(eventRaw).where(eq(eventRaw.ref, row.rawRef));
  // Never echo credentials that a sender put in headers.
  const safeHeaders = raw
    ? Object.fromEntries(
        Object.entries(raw.headers).filter(
          ([k]) => !/authorization|cookie|secret|token|signature/i.test(k),
        ),
      )
    : {};
  return {
    ...activity,
    attributes: row.attributes,
    dedupeKey: row.dedupeKey,
    deliveryId: row.deliveryId,
    stageReason: row.stageReason,
    raw: raw
      ? {
          headers: safeHeaders,
          body: raw.body.subarray(0, RAW_LIMIT).toString('utf8'),
          truncated: raw.body.length > RAW_LIMIT,
        }
      : null,
  };
}
