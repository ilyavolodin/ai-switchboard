import { randomUUID } from 'node:crypto';

import { and, eq, gt, inArray, sql } from 'drizzle-orm';

import {
  validateAgainst,
  type ArtifactRef,
  type Attributes,
  type EventDraft,
  type RawRequest,
} from '@ai-switchboard/sdk';

import type { Tx } from '../../db/client.js';
import { eventRaw, events, sources } from '../../db/schema.js';
import type { EventStage } from '../../domain/status.js';
import type { LiveSource } from '../../plugins/runtime.js';
import { recordAudit } from '../audit.js';

import { JOBS, errorMessage, lockKey, withTx, type Ctx } from './context.js';
import { PipelineError, isUuid } from './errors.js';

/**
 * Stage 1, receive: verify, store the raw delivery, parse, validate each event against its
 * declared schema, apply the door rules (disabled source, caps, muted types), write `events`
 * rows and enqueue matching. Everything after is a queue job.
 */

type SourceRow = typeof sources.$inferSelect;

const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);
/** Stages that count against a source's event caps. */
const ACCEPTED_STAGES: EventStage[] = ['received', 'matched', 'unmatched'];

/** Headers as stored: credentials dropped, any header carrying a secret value redacted. */
function storedHeaders(
  headers: Record<string, string | undefined>,
  secretValues: readonly string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const secrets = secretValues.filter((s) => s.length >= 4);
  for (const [k, v] of Object.entries(headers)) {
    if (DROPPED_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v !== undefined && secrets.some((s) => v.includes(s)) ? '[redacted]' : v;
  }
  return out;
}

interface CheckedDraft {
  stage: EventStage | null;
  reason: string | null;
  type: string;
  occurredAt: Date;
  artifact: ArtifactRef;
  attributes: Attributes;
  dedupeKey: string;
  deliveryId: string | null;
}

function isFlatValue(v: unknown): boolean {
  return (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    (Array.isArray(v) && v.every((x) => typeof x === 'string'))
  );
}

/** Validate one plugin-produced draft against the source's declared event types. */
export function checkDraft(draft: unknown, live: LiveSource, now: Date): CheckedDraft {
  const d = (draft !== null && typeof draft === 'object' ? draft : {}) as Partial<
    Record<keyof EventDraft, unknown>
  >;
  const problems: string[] = [];
  const type = typeof d.type === 'string' && d.type !== '' ? d.type : '(invalid)';
  const rawArtifact = (
    d.artifact !== null && typeof d.artifact === 'object' ? d.artifact : {}
  ) as Record<string, unknown>;
  const artifact: ArtifactRef = {
    kind: typeof rawArtifact.kind === 'string' ? rawArtifact.kind : '(invalid)',
    id: typeof rawArtifact.id === 'string' ? rawArtifact.id : '',
    ...(typeof rawArtifact.url === 'string' ? { url: rawArtifact.url } : {}),
    ...(typeof rawArtifact.version === 'string' ? { version: rawArtifact.version } : {}),
  };
  const attributes = (
    d.attributes !== null && typeof d.attributes === 'object' && !Array.isArray(d.attributes)
      ? structuredClone(d.attributes)
      : {}
  ) as Attributes;
  const occurred = typeof d.occurredAt === 'string' ? new Date(d.occurredAt) : new Date(Number.NaN);
  const dedupeKey = typeof d.dedupeKey === 'string' ? d.dedupeKey : '';

  if (draft === null || typeof draft !== 'object') problems.push('event is not an object');
  const spec = live.eventTypes.find((t) => t.type === type);
  if (!spec) problems.push(`event type ${type} is not declared by ${live.typeId}`);
  if (artifact.kind === '(invalid)' || artifact.kind === '' || artifact.id === '') {
    problems.push('artifact must have a kind and an id');
  }
  if (dedupeKey === '') problems.push('dedupeKey is missing');
  if (Number.isNaN(occurred.getTime())) problems.push('occurredAt is not an ISO-8601 time');
  for (const [k, v] of Object.entries(attributes)) {
    if (!isFlatValue(v)) problems.push(`attribute ${k} is not a scalar or a string array`);
  }
  if (spec) {
    try {
      const check = validateAgainst(spec.attributes, structuredClone(attributes));
      problems.push(...check.errors);
    } catch (err) {
      problems.push(`declared attribute schema is invalid: ${errorMessage(err)}`);
    }
  }
  const secrets = live.secretValues.filter((s) => s.length >= 4);
  if (secrets.length > 0) {
    const text = JSON.stringify(attributes);
    if (secrets.some((s) => text.includes(s)))
      problems.push('an attribute contains a secret value');
  }
  return {
    stage: problems.length > 0 ? 'event_invalid' : null,
    reason: problems.length > 0 ? problems.join('; ').slice(0, 1000) : null,
    type,
    occurredAt: Number.isNaN(occurred.getTime()) ? now : occurred,
    artifact,
    attributes: problems.length > 0 && !spec ? {} : attributes,
    dedupeKey,
    deliveryId: typeof d.deliveryId === 'string' && d.deliveryId !== '' ? d.deliveryId : null,
  };
}

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

/** Door rules and insert, in one transaction per delivery. */
export async function storeDrafts(
  ctx: Ctx,
  row: SourceRow,
  live: LiveSource,
  drafts: readonly unknown[],
  options: StoreOptions,
): Promise<StoreResult> {
  const now = ctx.clock.now();
  const checked = drafts.map((d) => checkDraft(d, live, now));
  const caps = row.caps;

  const result = await withTx(ctx.db, async (tx) => {
    const eventIds: string[] = [];
    const received: { id: string; type: string; stage: EventStage }[] = [];
    const all: { id: string; type: string; stage: EventStage; reason: string | null }[] = [];
    await lockKey(tx, `source-door:${row.id}`);
    let hourCount = 0;
    let dayCount = 0;
    const capsApply =
      options.bypassCaps !== true &&
      (caps.eventCapPerHour !== undefined || caps.eventCapPerDay !== undefined);
    if (capsApply) {
      const [counts] = await tx
        .select({
          hour: sql<number>`count(*) filter (where ${events.receivedAt} > ${new Date(now.getTime() - 3_600_000)})`.mapWith(
            Number,
          ),
          day: sql<number>`count(*)`.mapWith(Number),
        })
        .from(events)
        .where(
          and(
            eq(events.sourceId, row.id),
            gt(events.receivedAt, new Date(now.getTime() - 86_400_000)),
            inArray(events.stage, ACCEPTED_STAGES),
          ),
        );
      hourCount = counts?.hour ?? 0;
      dayCount = counts?.day ?? 0;
    }
    for (const c of checked) {
      let stage: EventStage;
      let reason = c.reason;
      if (!row.enabled) {
        stage = 'source_disabled';
      } else if (c.stage === 'event_invalid') {
        stage = 'event_invalid';
      } else if (caps.eventTypesEnabled !== undefined && !caps.eventTypesEnabled.includes(c.type)) {
        stage = 'type_muted';
      } else if (
        capsApply &&
        ((caps.eventCapPerHour !== undefined && hourCount >= caps.eventCapPerHour) ||
          (caps.eventCapPerDay !== undefined && dayCount >= caps.eventCapPerDay))
      ) {
        stage = 'source_throttled';
        reason =
          caps.eventCapPerHour !== undefined && hourCount >= caps.eventCapPerHour
            ? `eventCapPerHour ${caps.eventCapPerHour}`
            : `eventCapPerDay ${caps.eventCapPerDay}`;
      } else {
        stage = 'received';
        hourCount++;
        dayCount++;
      }
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
          stage,
          stageReason: reason,
          replayOf: options.replayOf ?? null,
        })
        // A redelivery with the same delivery id is already stored.
        .onConflictDoNothing()
        .returning({ id: events.id });
      if (inserted.length === 0) continue;
      eventIds.push(id);
      all.push({ id, type: c.type, stage, reason });
      if (stage === 'received') received.push({ id, type: c.type, stage });
    }
    if (received.length > 0) {
      await tx
        .update(sources)
        .set({ lastEventAt: now, silenceAlertedAt: null })
        .where(eq(sources.id, row.id));
    }
    if (options.inTx) await options.inTx(tx);
    return { eventIds, received, all };
  });

  for (const e of result.all) {
    ctx.telemetry.decision(
      'switchboard.events',
      { source: row.id, type: e.type, stage: e.stage },
      { event_id: e.id },
    );
    if (e.stage === 'event_invalid') {
      ctx.runtime.recordPluginError(live.pluginName, 'invalid_event', e.reason ?? undefined);
    }
  }
  for (const e of result.received) await ctx.queue.send(JOBS.match, { eventId: e.id });
  return { eventIds: result.eventIds, received: result.received.map((e) => e.id) };
}

async function storeRaw(
  ctx: Ctx,
  sourceId: string,
  body: Buffer,
  headers: Record<string, string | undefined>,
  verify: string,
): Promise<string> {
  const ref = randomUUID();
  await ctx.db.insert(eventRaw).values({
    ref,
    sourceId,
    body,
    headers,
    receivedAt: ctx.clock.now(),
    verify,
  });
  return ref;
}

/** POST /hooks/:sourceId */
export async function ingestPush(
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
      await storeRaw(ctx, sourceId, Buffer.alloc(0), {}, 'unverified:source_disabled');
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

    const unauthenticated =
      row.caps.unauthenticated === true && live.type.allowsUnauthenticated === true;
    if (!unauthenticated) {
      let verdict: { ok: boolean; reason?: string };
      if (!live.source.verify) {
        verdict = { ok: false, reason: 'source has no verify and is not marked unauthenticated' };
      } else {
        try {
          verdict = live.source.verify(req);
        } catch (err) {
          ctx.runtime.recordPluginError(
            live.pluginName,
            'exception',
            `verify: ${errorMessage(err)}`,
          );
          verdict = { ok: false, reason: 'verify threw' };
        }
      }
      if (!verdict.ok) {
        const reason = verdict.reason ?? 'rejected';
        ctx.log.warn(
          { source_id: sourceId, remote_address: req.remoteAddress, reason },
          'hook rejected by verify',
        );
        // Counted for the source's verify-failure chart; the unauthenticated body is not kept.
        await storeRaw(ctx, sourceId, Buffer.alloc(0), {}, `rejected:${reason}`.slice(0, 200));
        await ctx.db
          .update(sources)
          .set({ lastVerifyFailureAt: ctx.clock.now() })
          .where(eq(sources.id, sourceId));
        return { status: 401 };
      }
    }

    const rawRef = await storeRaw(
      ctx,
      sourceId,
      req.body,
      storedHeaders(req.headers, live.secretValues),
      'ok',
    );
    let drafts: unknown[] = [];
    if (live.source.parse) {
      try {
        const parsed: unknown = await live.source.parse(req);
        drafts = Array.isArray(parsed) ? parsed : [];
        if (!Array.isArray(parsed)) {
          ctx.runtime.recordPluginError(
            live.pluginName,
            'invalid_event',
            'parse did not return an array',
          );
        }
      } catch (err) {
        ctx.runtime.recordPluginError(live.pluginName, 'exception', `parse: ${errorMessage(err)}`);
        return { status: 200 };
      }
    }
    await storeDrafts(ctx, row, live, drafts, { rawRef });
    return { status: 200 };
  } catch (err) {
    ctx.log.error({ err, source_id: sourceId }, 'ingest failed; asking the sender to retry');
    return { status: 503 };
  }
}

/** Pull sources: one poll, events and the new watermark in one transaction. */
export async function pollSource(ctx: Ctx, sourceId: string): Promise<void> {
  const [row] = await ctx.db.select().from(sources).where(eq(sources.id, sourceId));
  if (!row?.enabled) return;
  const live = ctx.runtime.source(sourceId);
  if (!live?.source.poll) return;
  let out: { events: unknown; watermark: unknown };
  try {
    out = await live.source.poll(row.watermark);
  } catch (err) {
    ctx.log.warn({ err, source_id: sourceId }, 'poll failed');
    return;
  }
  const drafts = Array.isArray(out.events) ? (out.events as unknown[]) : [];
  const watermark = typeof out.watermark === 'string' ? out.watermark : row.watermark;
  const rawRef = await storeRaw(
    ctx,
    sourceId,
    Buffer.from(JSON.stringify(drafts)),
    { 'x-switchboard-origin': 'poll' },
    'ok',
  );
  await storeDrafts(ctx, row, live, drafts, {
    rawRef,
    inTx: async (tx) => {
      await tx.update(sources).set({ watermark }).where(eq(sources.id, sourceId));
    },
  });
}

/** Re-inject a stored raw body through the same parse; new events carry `replayOf`. */
export async function replayEvent(
  ctx: Ctx,
  eventId: string,
  actor: string,
  reason: string,
): Promise<{ eventIds: string[] }> {
  if (!isUuid(eventId)) throw new PipelineError('not_found', `event ${eventId} not found`);
  const [event] = await ctx.db.select().from(events).where(eq(events.id, eventId));
  if (!event) throw new PipelineError('not_found', `event ${eventId} not found`);
  const [raw] = await ctx.db.select().from(eventRaw).where(eq(eventRaw.ref, event.rawRef));
  const [row] = await ctx.db.select().from(sources).where(eq(sources.id, event.sourceId));
  if (!row) throw new PipelineError('not_found', `source ${event.sourceId} not found`);
  const live = ctx.runtime.source(event.sourceId);
  if (!live) throw new PipelineError('unavailable', `source ${row.name} has no live instance`);

  const origin = raw?.headers['x-switchboard-origin'];
  let drafts: unknown[];
  if (!raw || origin === 'poll' || origin === 'test' || !live.source.parse) {
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
    const req: RawRequest = {
      method: 'POST',
      path: `/hooks/${event.sourceId}`,
      headers: raw.headers,
      query: {},
      body: raw.body,
      receivedAt: raw.receivedAt.toISOString(),
    };
    try {
      const parsed: unknown = await live.source.parse(req);
      drafts = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      ctx.runtime.recordPluginError(live.pluginName, 'exception', `parse: ${errorMessage(err)}`);
      throw new PipelineError('invalid', `parse failed on replay: ${errorMessage(err)}`);
    }
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

/** "Send test event": the source type's first example for `type` (or its first event type). */
export async function injectTestEvent(
  ctx: Ctx,
  sourceId: string,
  type: string | undefined,
  actor: string,
  reason: string,
): Promise<{ eventIds: string[] }> {
  if (!isUuid(sourceId)) throw new PipelineError('not_found', `source ${sourceId} not found`);
  const [row] = await ctx.db.select().from(sources).where(eq(sources.id, sourceId));
  if (!row) throw new PipelineError('not_found', `source ${sourceId} not found`);
  const live = ctx.runtime.source(sourceId);
  if (!live) throw new PipelineError('unavailable', `source ${row.name} has no live instance`);
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
  const rawRef = await storeRaw(
    ctx,
    sourceId,
    Buffer.from(JSON.stringify(draft)),
    { 'x-switchboard-origin': 'test' },
    'ok',
  );
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
