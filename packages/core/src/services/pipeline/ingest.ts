import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import type { EventDraft, RawRequest } from '@ai-switchboard/sdk';

import type { Tx } from '../../db/client.js';
import { eventRaw, events, sources } from '../../db/schema.js';
import { lockKey, withTx } from '../../db/tx.js';
import { acceptsUnauthenticated } from '../../domain/authentication.js';
import { ACCEPTED_STAGES, type EventStage, type RawOrigin } from '../../domain/status.js';
import {
  capsApply,
  checkDraft,
  doorStage,
  storedHeaders,
  type DoorCounts,
} from '../../pipeline/door.js';
import { checkPollResult } from '../../pipeline/plugin-results.js';
import type { LiveSource } from '../../plugins/runtime.js';
import { auditChange, type ChangeMeta } from '../audit.js';
import { DomainError, invalid, unavailable } from '../errors.js';
import { findById, requireById } from '../lookup.js';
import { hookPath } from '../urls.js';

import type { Ctx } from './context.js';
import { hourDayCounts } from './counters.js';
import { JOBS } from './jobs.js';
import type { IngressOutcome } from './outcomes.js';
import { callPlugin } from './plugin-call.js';

type SourceRow = typeof sources.$inferSelect;

export interface StoreOptions {
  rawRef: string;
  replayOf?: string;
  /** Operator-injected events (test events, replays) skip the caps. */
  bypassCaps?: boolean;
  /** Extra writes in the same transaction (a pull source's watermark, an audit row). */
  inTx?: (tx: Tx, eventIds: string[]) => Promise<void>;
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

function acceptedCounts(tx: Tx, sourceId: string, now: Date): Promise<DoorCounts> {
  return hourDayCounts(
    tx,
    events,
    events.receivedAt,
    and(eq(events.sourceId, sourceId), inArray(events.stage, ACCEPTED_STAGES)),
    now,
  );
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
    await options.inTx?.(
      tx,
      stored.map((e) => e.id),
    );
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

/**
 * `accepted` also for a disabled source; `unavailable` when Postgres or the live instance is
 * missing, so the sender retries.
 */
export function ingestPush(ctx: Ctx, sourceId: string, req: RawRequest): Promise<IngressOutcome> {
  return ctx.telemetry.span(
    'switchboard.ingest',
    { source_id: sourceId, 'switchboard.ingest.origin': 'push' },
    async (span) => {
      const out = await ingestPushInSpan(ctx, sourceId, req);
      span.setAttributes({ 'switchboard.ingest.outcome': out });
      return out;
    },
  );
}

async function ingestPushInSpan(
  ctx: Ctx,
  sourceId: string,
  req: RawRequest,
): Promise<IngressOutcome> {
  try {
    const row = await findById(ctx.db, sources, sourceId);
    if (!row) return 'not_found';
    const live = ctx.runtime.source(sourceId);
    if (!live && !row.enabled) {
      // A disabled source always answers 200 so the sender does not enter a retry storm. With
      // no live instance the delivery cannot be verified, so its body is not kept.
      await storeRaw(ctx, sourceId, unverifiedRaw('unverified:source_disabled'));
      return 'accepted';
    }
    if (!live) {
      // The instance cannot verify or parse right now (plugin unavailable, secret error):
      // ask the sender to redeliver later.
      ctx.log.warn(
        { source_id: sourceId, reason: ctx.runtime.instanceError(sourceId) },
        'hook received for a source with no live instance',
      );
      return 'unavailable';
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
      return 'rejected';
    }

    const rawRef = await storeRaw(ctx, sourceId, {
      body: req.body,
      headers: storedHeaders(req.headers, live.secretValues),
      verify: 'ok',
      origin: 'push',
    });
    const parsed = await parseDrafts(ctx, live, req);
    // A failed parse keeps the raw body for a replay; the sender must not redeliver.
    if (!parsed.ok) return 'accepted';
    await storeDrafts(ctx, row, live, parsed.drafts, { rawRef });
    return 'accepted';
  } catch (err) {
    ctx.log.error({ err, source_id: sourceId }, 'ingest failed; asking the sender to retry');
    return 'unavailable';
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
  const page = checkPollResult(polled.value, row.watermark);
  if (!page.ok) {
    ctx.runtime.recordPluginError(live.pluginName, 'exception', page.problem);
    return;
  }
  const { drafts, watermark, notes } = page.value;
  ctx.telemetry.annotate({ 'switchboard.poll.notes': notes.length });
  if (notes.length > 0) {
    ctx.log.info({ source_id: sourceId, notes }, 'poll dropped part of its results');
  }
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
  const row = await requireById(ctx.db, sources, sourceId, 'Source');
  const live = ctx.runtime.source(sourceId);
  if (!live) throw unavailable(`source ${row.name} has no live instance`);
  return { row, live };
}

export function replayEvent(
  ctx: Ctx,
  eventId: string,
  meta: ChangeMeta,
): Promise<{ eventIds: string[] }> {
  return ctx.telemetry.span(
    'switchboard.ingest',
    { event_id: eventId, 'switchboard.ingest.origin': 'replay' },
    () => replayEventInSpan(ctx, eventId, meta),
  );
}

async function replayEventInSpan(
  ctx: Ctx,
  eventId: string,
  meta: ChangeMeta,
): Promise<{ eventIds: string[] }> {
  const event = await requireById(ctx.db, events, eventId, 'Event');
  const [raw] = await ctx.db.select().from(eventRaw).where(eq(eventRaw.ref, event.rawRef));
  const { row, live } = await liveSourceOrThrow(ctx, event.sourceId);

  let drafts: unknown[];
  if (raw?.origin !== 'push' || !live.source.parse) {
    if (!raw && live.source.parse) {
      throw new DomainError('not_found', 'the raw body is no longer stored (retention)');
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
      path: hookPath(event.sourceId),
      headers: raw.headers,
      query: {},
      body: raw.body,
      receivedAt: raw.receivedAt.toISOString(),
    });
    if (!parsed.ok) throw invalid(`parse failed on replay: ${parsed.error}`);
    drafts = parsed.drafts;
  }
  const out = await storeDrafts(ctx, row, live, drafts, {
    rawRef: event.rawRef,
    replayOf: event.id,
    bypassCaps: true,
    inTx: (tx, eventIds) =>
      auditChange(tx, meta, {
        scope: 'event',
        targetId: event.id,
        field: 'replay',
        after: { eventIds },
      }),
  });
  return { eventIds: out.eventIds };
}

export function injectTestEvent(
  ctx: Ctx,
  sourceId: string,
  type: string | undefined,
  meta: ChangeMeta,
): Promise<{ eventIds: string[] }> {
  return ctx.telemetry.span(
    'switchboard.ingest',
    { source_id: sourceId, 'switchboard.ingest.origin': 'test' },
    () => injectTestEventInSpan(ctx, sourceId, type, meta),
  );
}

async function injectTestEventInSpan(
  ctx: Ctx,
  sourceId: string,
  type: string | undefined,
  meta: ChangeMeta,
): Promise<{ eventIds: string[] }> {
  const { row, live } = await liveSourceOrThrow(ctx, sourceId);
  const spec =
    type === undefined ? live.eventTypes[0] : live.eventTypes.find((t) => t.type === type);
  if (!spec) {
    throw invalid(`source ${row.name} declares no event type ${type ?? ''}`.trim());
  }
  const nonce = randomUUID();
  const draft: EventDraft = {
    type: spec.type,
    occurredAt: meta.now.toISOString(),
    artifact: { kind: `${live.typeId}.test`, id: `test-${nonce.slice(0, 8)}` },
    attributes: structuredClone(spec.examples[0] ?? {}),
    dedupeKey: `${spec.type}:test:${nonce}`,
  };
  const rawRef = await storeRaw(ctx, sourceId, {
    body: Buffer.from(JSON.stringify(draft)),
    headers: {},
    verify: 'ok',
    origin: 'test',
  });
  const out = await storeDrafts(ctx, row, live, [draft], {
    rawRef,
    bypassCaps: true,
    inTx: (tx, eventIds) =>
      auditChange(tx, meta, {
        scope: 'source',
        targetId: sourceId,
        field: 'test_event',
        after: { type: spec.type, eventIds },
      }),
  });
  return { eventIds: out.eventIds };
}
