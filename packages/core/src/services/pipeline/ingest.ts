import { randomUUID } from 'node:crypto';

import { and, eq, gt, inArray, sql } from 'drizzle-orm';

import type { EventDraft, RawRequest } from '@ai-switchboard/sdk';

import type { Tx } from '../../db/client.js';
import { eventRaw, events, sources } from '../../db/schema.js';
import { acceptsUnauthenticated } from '../../domain/authentication.js';
import { ACCEPTED_STAGES, type EventStage, type RawOrigin } from '../../domain/status.js';
import {
  capsApply,
  checkDraft,
  doorStage,
  sourceNotes,
  storedHeaders,
  type DoorCounts,
} from '../../pipeline/door.js';
import type { LiveSource } from '../../plugins/runtime.js';
import { DAY_MS, HOUR_MS } from '../../util/time.js';
import { isUuid } from '../../util/uuid.js';
import { recordAudit } from '../audit.js';

import type { Ctx } from './context.js';
import { PipelineError, findOrThrow } from './errors.js';
import { JOBS } from './jobs.js';
import { callPlugin } from './plugin-call.js';
import { lockKey, withTx } from './tx.js';

/** Kept for `services/source-preview.ts`; new code imports it from `pipeline/door.js`. */
export { checkDraft } from '../../pipeline/door.js';

type SourceRow = typeof sources.$inferSelect;

export interface StoreOptions {
  rawRef: string;
  replayOf?: string;
  /** Operator-injected events (test events, replays) skip the caps. */
  bypassCaps?: boolean;
  /** Extra writes in the same transaction (a pull source's watermark). */
  inTx?: (tx: Tx) => Promise<void>;
}

export interface StoreResult {
  eventIds: string[];
  received: string[];
}

interface StoredEvent {
  id: string;
  type: string;
  stage: EventStage;
  reason: string | null;
}

async function acceptedCounts(tx: Tx, sourceId: string, now: Date): Promise<DoorCounts> {
  const [counts] = await tx
    .select({
      hour: sql<number>`count(*) filter (where ${events.receivedAt} > ${new Date(now.getTime() - HOUR_MS)})`.mapWith(
        Number,
      ),
      day: sql<number>`count(*)`.mapWith(Number),
    })
    .from(events)
    .where(
      and(
        eq(events.sourceId, sourceId),
        gt(events.receivedAt, new Date(now.getTime() - DAY_MS)),
        inArray(events.stage, ACCEPTED_STAGES),
      ),
    );
  return { hour: counts?.hour ?? 0, day: counts?.day ?? 0 };
}

async function storeDrafts(
  ctx: Ctx,
  row: SourceRow,
  live: LiveSource,
  drafts: readonly unknown[],
  options: StoreOptions,
): Promise<StoreResult> {
  const now = ctx.clock.now();
  const checked = drafts.map((d) => checkDraft(d, live, now));
  // The ingest span: each event's match job continues it, and its batch's dispatch links to it.
  const traceContext = ctx.telemetry.traceparent() ?? null;

  const all = await withTx(ctx.db, async (tx) => {
    const stored: StoredEvent[] = [];
    await lockKey(tx, `source-door:${row.id}`);
    let counts = capsApply(row.caps, options.bypassCaps === true)
      ? await acceptedCounts(tx, row.id, now)
      : null;
    for (const c of checked) {
      const door = doorStage(c, row, counts);
      counts = door.counts;
      const id = randomUUID();
      const inserted = await tx
        .insert(events)
        .values({
          id,
          sourceId: row.id,
          sourceType: live.typeId,
          type: c.type,
          occurredAt: c.occurredAt,
          receivedAt: now,
          artifact: c.artifact,
          artifactKey: `${c.artifact.kind}:${c.artifact.id}`,
          attributes: c.attributes,
          dedupeKey: c.dedupeKey,
          deliveryId: c.deliveryId,
          rawRef: options.rawRef,
          stage: door.stage,
          stageReason: door.reason,
          replayOf: options.replayOf ?? null,
          traceContext,
        })
        // A redelivery with the same delivery id is already stored.
        .onConflictDoNothing()
        .returning({ id: events.id });
      if (inserted.length === 0) continue;
      stored.push({ id, type: c.type, stage: door.stage, reason: door.reason });
    }
    if (stored.some((e) => e.stage === 'received')) {
      await tx
        .update(sources)
        .set({ lastEventAt: now, silenceAlertedAt: null })
        .where(eq(sources.id, row.id));
    }
    if (options.inTx) await options.inTx(tx);
    return stored;
  });
  const received = all.filter((e) => e.stage === 'received');

  for (const e of all) {
    ctx.telemetry.decision(
      'switchboard.events',
      { source: row.id, type: e.type, stage: e.stage },
      { event_id: e.id },
    );
    if (e.stage === 'event_invalid') {
      ctx.runtime.recordPluginError(live.pluginName, 'invalid_event', e.reason ?? undefined);
    }
  }
  ctx.telemetry.annotate({
    plugin: live.pluginName,
    'switchboard.source.type': live.typeId,
    'switchboard.events.count': all.length,
    'switchboard.events.received': received.length,
    event_ids: all.map((e) => e.id),
    ...(all.length === 1 ? { event_id: all[0]?.id } : {}),
  });
  for (const e of received) await ctx.queue.send(JOBS.match, { eventId: e.id });
  return { eventIds: all.map((e) => e.id), received: received.map((e) => e.id) };
}

async function storeRaw(
  ctx: Ctx,
  sourceId: string,
  raw: {
    body: Buffer;
    headers: Record<string, string | undefined>;
    verify: string;
    origin: RawOrigin;
  },
): Promise<string> {
  const ref = randomUUID();
  await ctx.db.insert(eventRaw).values({ ref, sourceId, ...raw, receivedAt: ctx.clock.now() });
  return ref;
}

function unverifiedRaw(verify: string) {
  return { body: Buffer.alloc(0), headers: {}, verify, origin: 'push' as const };
}

/**
 * `parse` goes through the plugin-call wrapper (timeout, attribution); a result that is not an
 * array is counted against the plugin and yields no events.
 */
async function parseDrafts(
  ctx: Ctx,
  live: LiveSource,
  req: RawRequest,
): Promise<{ ok: true; drafts: unknown[] } | { ok: false; error: string }> {
  const parse = live.source.parse?.bind(live.source);
  if (!parse) return { ok: true, drafts: [] };
  const out = await callPlugin(ctx, live.pluginName, 'parse', () => parse(req));
  if (!out.ok) return out;
  const parsed: unknown = out.value;
  if (Array.isArray(parsed)) return { ok: true, drafts: parsed as unknown[] };
  ctx.runtime.recordPluginError(live.pluginName, 'invalid_event', 'parse did not return an array');
  return { ok: true, drafts: [] };
}

export function ingestPush(
  ctx: Ctx,
  sourceId: string,
  req: RawRequest,
): Promise<{ status: number }> {
  return ctx.telemetry.span(
    'switchboard.ingest',
    { source_id: sourceId, 'switchboard.ingest.origin': 'push' },
    async (span) => {
      const out = await ingestPushInSpan(ctx, sourceId, req);
      span.setAttributes({ 'http.response.status_code': out.status });
      return out;
    },
  );
}

async function ingestPushInSpan(
  ctx: Ctx,
  sourceId: string,
  req: RawRequest,
): Promise<{ status: number }> {
  if (!isUuid(sourceId)) return { status: 404 };
  try {
    const [row] = await ctx.db.select().from(sources).where(eq(sources.id, sourceId));
    if (!row) return { status: 404 };
    const live = ctx.runtime.source(sourceId);
    if (!live && !row.enabled) {
      // A disabled source always answers 200 so the sender does not enter a retry storm. With
      // no live instance the delivery cannot be verified, so its body is not kept.
      await storeRaw(ctx, sourceId, unverifiedRaw('unverified:source_disabled'));
      return { status: 200 };
    }
    if (!live) {
      // The instance cannot verify or parse right now (plugin unavailable, secret error):
      // ask the sender to redeliver later.
      ctx.log.warn(
        { source_id: sourceId, reason: ctx.runtime.instanceError(sourceId) },
        'hook received for a source with no live instance',
      );
      return { status: 503 };
    }

    const verdict = verifyDelivery(live, req);
    if (!verdict.ok) {
      const reason = verdict.reason ?? 'rejected';
      ctx.log.warn(
        { source_id: sourceId, remote_address: req.remoteAddress, reason },
        'hook rejected by verify',
      );
      // Counted for the source's verify-failure chart; the unauthenticated body is not kept.
      await storeRaw(ctx, sourceId, unverifiedRaw(`rejected:${reason}`.slice(0, 200)));
      await ctx.db
        .update(sources)
        .set({ lastVerifyFailureAt: ctx.clock.now() })
        .where(eq(sources.id, sourceId));
      return { status: 401 };
    }

    const rawRef = await storeRaw(ctx, sourceId, {
      body: req.body,
      headers: storedHeaders(req.headers, live.secretValues),
      verify: 'ok',
      origin: 'push',
    });
    const parsed = await parseDrafts(ctx, live, req);
    // A failed parse keeps the raw body for a replay; the sender must not redeliver.
    if (!parsed.ok) return { status: 200 };
    await storeDrafts(ctx, row, live, parsed.drafts, { rawRef });
    return { status: 200 };
  } catch (err) {
    ctx.log.error({ err, source_id: sourceId }, 'ingest failed; asking the sender to retry');
    return { status: 503 };
  }
}

/**
 * Derived from the built instance (the webhook's `verification: none`), never from a flag alone,
 * so a type that must verify can never skip it.
 */
function verifyDelivery(live: LiveSource, req: RawRequest): { ok: boolean; reason?: string } {
  if (acceptsUnauthenticated(live.type, live.source)) return { ok: true };
  if (!live.source.verify) {
    return { ok: false, reason: 'source has no verify and its type requires one' };
  }
  try {
    return live.source.verify(req);
  } catch {
    // Counted against the plugin by the runtime's attribution wrapper.
    return { ok: false, reason: 'verify threw' };
  }
}

export function pollSource(ctx: Ctx, sourceId: string): Promise<void> {
  return ctx.telemetry.span(
    'switchboard.ingest',
    { source_id: sourceId, 'switchboard.ingest.origin': 'poll' },
    () => pollSourceInSpan(ctx, sourceId),
  );
}

/** Events and the new watermark are written in one transaction. */
async function pollSourceInSpan(ctx: Ctx, sourceId: string): Promise<void> {
  const [row] = await ctx.db.select().from(sources).where(eq(sources.id, sourceId));
  if (!row?.enabled) return;
  const live = ctx.runtime.source(sourceId);
  if (!live?.source.poll) return;
  const poll = live.source.poll.bind(live.source);
  const polled = await callPlugin(ctx, live.pluginName, 'poll', () => poll(row.watermark));
  if (!polled.ok) {
    ctx.log.warn({ err: polled.error, source_id: sourceId }, 'poll failed');
    return;
  }
  const out: unknown = polled.value;
  if (out === null || typeof out !== 'object') {
    ctx.runtime.recordPluginError(live.pluginName, 'exception', 'poll returned no result object');
    return;
  }
  const {
    events: polledEvents,
    watermark: next,
    notes: rawNotes,
  } = out as {
    events?: unknown;
    watermark?: unknown;
    notes?: unknown;
  };
  const drafts = Array.isArray(polledEvents) ? (polledEvents as unknown[]) : [];
  const notes = sourceNotes(rawNotes);
  ctx.telemetry.annotate({ 'switchboard.poll.notes': notes.length });
  if (notes.length > 0) {
    ctx.log.info({ source_id: sourceId, notes }, 'poll dropped part of its results');
  }
  const watermark = typeof next === 'string' ? next : row.watermark;
  const rawRef = await storeRaw(ctx, sourceId, {
    body: Buffer.from(JSON.stringify(drafts)),
    headers: {},
    verify: 'ok',
    origin: 'poll',
  });
  try {
    await storeDrafts(ctx, row, live, drafts, {
      rawRef,
      inTx: async (tx) => {
        // Compare-and-set: a poll that overlapped another one (slow backend, redelivered job)
        // started from a watermark that has moved on; its page was already emitted.
        const [current] = await tx
          .select({ watermark: sources.watermark })
          .from(sources)
          .where(eq(sources.id, sourceId))
          .for('update');
        if ((current?.watermark ?? null) !== row.watermark) throw new WatermarkMoved();
        await tx.update(sources).set({ watermark }).where(eq(sources.id, sourceId));
      },
    });
  } catch (err) {
    if (!(err instanceof WatermarkMoved)) throw err;
    await ctx.db.delete(eventRaw).where(eq(eventRaw.ref, rawRef));
    ctx.log.info({ source_id: sourceId }, 'poll overlapped another; its page is dropped');
  }
}

class WatermarkMoved extends Error {
  override readonly name = 'WatermarkMoved';
}

async function liveSourceOrThrow(
  ctx: Ctx,
  sourceId: string,
): Promise<{ row: SourceRow; live: LiveSource }> {
  const row = await findOrThrow('source', sourceId, async () => {
    const [found] = await ctx.db.select().from(sources).where(eq(sources.id, sourceId));
    return found;
  });
  const live = ctx.runtime.source(sourceId);
  if (!live) throw new PipelineError('unavailable', `source ${row.name} has no live instance`);
  return { row, live };
}

export function replayEvent(
  ctx: Ctx,
  eventId: string,
  actor: string,
  reason: string,
): Promise<{ eventIds: string[] }> {
  return ctx.telemetry.span(
    'switchboard.ingest',
    { event_id: eventId, 'switchboard.ingest.origin': 'replay' },
    () => replayEventInSpan(ctx, eventId, actor, reason),
  );
}

async function replayEventInSpan(
  ctx: Ctx,
  eventId: string,
  actor: string,
  reason: string,
): Promise<{ eventIds: string[] }> {
  const event = await findOrThrow('event', eventId, async () => {
    const [found] = await ctx.db.select().from(events).where(eq(events.id, eventId));
    return found;
  });
  const [raw] = await ctx.db.select().from(eventRaw).where(eq(eventRaw.ref, event.rawRef));
  const { row, live } = await liveSourceOrThrow(ctx, event.sourceId);

  let drafts: unknown[];
  if (raw?.origin !== 'push' || !live.source.parse) {
    if (!raw && live.source.parse) {
      throw new PipelineError('not_found', 'the raw body is no longer stored (retention)');
    }
    // Polled and injected events have no delivery to re-parse: re-inject the event itself.
    drafts = [
      {
        type: event.type,
        occurredAt: event.occurredAt.toISOString(),
        artifact: event.artifact,
        attributes: event.attributes,
        dedupeKey: event.dedupeKey,
        ...(event.deliveryId !== null ? { deliveryId: event.deliveryId } : {}),
      },
    ];
  } else {
    const parsed = await parseDrafts(ctx, live, {
      method: 'POST',
      path: `/hooks/${event.sourceId}`,
      headers: raw.headers,
      query: {},
      body: raw.body,
      receivedAt: raw.receivedAt.toISOString(),
    });
    if (!parsed.ok) {
      throw new PipelineError('invalid', `parse failed on replay: ${parsed.error}`);
    }
    drafts = parsed.drafts;
  }
  const out = await storeDrafts(ctx, row, live, drafts, {
    rawRef: event.rawRef,
    replayOf: event.id,
    bypassCaps: true,
  });
  await recordAudit(ctx.db, {
    actor,
    scope: 'event',
    targetId: event.id,
    field: 'replay',
    after: { eventIds: out.eventIds },
    reason,
    at: ctx.clock.now(),
  });
  return { eventIds: out.eventIds };
}

export function injectTestEvent(
  ctx: Ctx,
  sourceId: string,
  type: string | undefined,
  actor: string,
  reason: string,
): Promise<{ eventIds: string[] }> {
  return ctx.telemetry.span(
    'switchboard.ingest',
    { source_id: sourceId, 'switchboard.ingest.origin': 'test' },
    () => injectTestEventInSpan(ctx, sourceId, type, actor, reason),
  );
}

async function injectTestEventInSpan(
  ctx: Ctx,
  sourceId: string,
  type: string | undefined,
  actor: string,
  reason: string,
): Promise<{ eventIds: string[] }> {
  const { row, live } = await liveSourceOrThrow(ctx, sourceId);
  const spec =
    type === undefined ? live.eventTypes[0] : live.eventTypes.find((t) => t.type === type);
  if (!spec) {
    throw new PipelineError(
      'invalid',
      `source ${row.name} declares no event type ${type ?? ''}`.trim(),
    );
  }
  const now = ctx.clock.now();
  const nonce = randomUUID();
  const attributes = structuredClone(spec.examples[0] ?? {});
  const draft: EventDraft = {
    type: spec.type,
    occurredAt: now.toISOString(),
    artifact: { kind: `${live.typeId}.test`, id: `test-${nonce.slice(0, 8)}` },
    attributes,
    dedupeKey: `${spec.type}:test:${nonce}`,
  };
  const rawRef = await storeRaw(ctx, sourceId, {
    body: Buffer.from(JSON.stringify(draft)),
    headers: {},
    verify: 'ok',
    origin: 'test',
  });
  const out = await storeDrafts(ctx, row, live, [draft], { rawRef, bypassCaps: true });
  await recordAudit(ctx.db, {
    actor,
    scope: 'source',
    targetId: sourceId,
    field: 'test_event',
    after: { type: spec.type, eventIds: out.eventIds },
    reason,
    at: now,
  });
  return { eventIds: out.eventIds };
}
