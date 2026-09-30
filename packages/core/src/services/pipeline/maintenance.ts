import { hostname } from 'node:os';

import { and, eq, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';

import { batches, events, destinations, replicas, sources } from '../../db/schema.js';
import { DEFAULT_METER_POLL_SECONDS, MIN_METER_POLL_SECONDS } from '../../domain/defaults.js';
import { MINUTE_MS, SECOND_MS } from '../../util/time.js';
import { getSettings } from '../settings.js';

import type { Ctx } from './context.js';
import { JOBS } from './jobs.js';
import { sendSystemAlert } from './notify.js';
import { recoverRuns } from './runs.js';

/** Every step is safe to run on several replicas at once: claims are conditional updates. */

const DEFAULT_POLL_SECONDS = 300;
/** A `received` event not matched by then lost its match job. */
const STUCK_EVENT_SECONDS = 60;
/** An open batch this far past `fire_after` lost its fire job. */
const OVERDUE_FIRE_SECONDS = 30;
/** A closed batch not dispatched by then lost its dispatch job. */
const UNDISPATCHED_SECONDS = 60;
/** One re-enqueue per row in this window, however many replicas run maintenance. */
const REQUEUE_SLOT_SECONDS = 300;
const REQUEUE_LIMIT = 1000;

async function requeue(
  ctx: Ctx,
  job: string,
  key: 'eventId' | 'batchId',
  ids: readonly { id: string }[],
): Promise<void> {
  for (const { id } of ids) {
    await ctx.queue.send(
      job,
      { [key]: id },
      { singletonKey: `requeue:${id}`, singletonSeconds: REQUEUE_SLOT_SECONDS },
    );
  }
}

export async function maintenance(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const ago = (seconds: number) => new Date(now.getTime() - seconds * SECOND_MS);

  const stuckEvents = await ctx.db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.stage, 'received'), lt(events.receivedAt, ago(STUCK_EVENT_SECONDS))))
    .limit(REQUEUE_LIMIT);
  await requeue(ctx, JOBS.match, 'eventId', stuckEvents);

  const dueBatches = await ctx.db
    .select({ id: batches.id })
    .from(batches)
    .where(and(eq(batches.outcome, 'open'), lt(batches.fireAfter, ago(OVERDUE_FIRE_SECONDS))))
    .limit(REQUEUE_LIMIT);
  await requeue(ctx, JOBS.fire, 'batchId', dueBatches);

  const undispatched = await ctx.db
    .select({ id: batches.id })
    .from(batches)
    .where(and(eq(batches.outcome, 'closed'), lt(batches.closedAt, ago(UNDISPATCHED_SECONDS))))
    .limit(REQUEUE_LIMIT);
  await requeue(ctx, JOBS.dispatch, 'batchId', undispatched);

  await recoverRuns(ctx);
  await claimSourcePolls(ctx, now);
  await claimMeterReads(ctx, now);
  await silentSources(ctx, now);
}

/** Claims `row` when `column` is unset or older than `intervalSeconds`; replicas race on it. */
async function claimIfDue(
  claim: (due: SQL | undefined) => Promise<readonly unknown[]>,
  column: Parameters<typeof isNull>[0],
  now: Date,
  intervalSeconds: number,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - intervalSeconds * SECOND_MS);
  const claimed = await claim(or(isNull(column), lte(column, cutoff)));
  return claimed.length > 0;
}

async function claimSourcePolls(ctx: Ctx, now: Date): Promise<void> {
  const rows = await ctx.db.select().from(sources).where(eq(sources.enabled, true));
  for (const row of rows) {
    const live = ctx.runtime.source(row.id);
    if (!live?.source.poll || live.type.mode === 'push') continue;
    const interval = Math.max(10, row.caps.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS);
    const due = await claimIfDue(
      (when) =>
        ctx.db
          .update(sources)
          .set({ lastPolledAt: now })
          .where(and(eq(sources.id, row.id), when))
          .returning({ id: sources.id }),
      sources.lastPolledAt,
      now,
      interval,
    );
    if (due) await ctx.queue.send(JOBS.sourcePoll, { sourceId: row.id });
  }
}

async function claimMeterReads(ctx: Ctx, now: Date): Promise<void> {
  const rows = await ctx.db.select().from(destinations).where(eq(destinations.enabled, true));
  for (const row of rows) {
    const live = ctx.runtime.destination(row.id);
    if (!live || live.meters.length === 0) continue;
    const interval = Math.max(
      MIN_METER_POLL_SECONDS,
      row.caps.meterPollSeconds ?? DEFAULT_METER_POLL_SECONDS,
    );
    const due = await claimIfDue(
      (when) =>
        ctx.db
          .update(destinations)
          .set({ metersReadAt: now })
          .where(and(eq(destinations.id, row.id), when))
          .returning({ id: destinations.id }),
      destinations.metersReadAt,
      now,
      interval,
    );
    if (due) await ctx.queue.send(JOBS.metersRead, { destinationId: row.id });
  }
}

async function silentSources(ctx: Ctx, now: Date): Promise<void> {
  const settings = await getSettings(ctx.db);
  const minutes = settings.sourceSilenceMinutes;
  if (minutes <= 0) return;
  const cutoff = new Date(now.getTime() - minutes * MINUTE_MS);
  const silent = await ctx.db
    .update(sources)
    .set({ silenceAlertedAt: now })
    .where(
      and(
        eq(sources.enabled, true),
        isNull(sources.silenceAlertedAt),
        // A source that never received anything is silent since it was created.
        sql`COALESCE(${sources.lastEventAt}, ${sources.createdAt}) < ${cutoff}`,
      ),
    )
    .returning({ id: sources.id, name: sources.name, lastEventAt: sources.lastEventAt });
  for (const s of silent) {
    ctx.telemetry.gauge('switchboard.source.health', 0, { source: s.id });
    await sendSystemAlert(ctx, {
      key: `source_silent:${s.id}`,
      title: `Source silent: ${s.name}`,
      text: `No events from ${s.name} since ${s.lastEventAt?.toISOString() ?? 'it was created'} (more than ${minutes} minutes). Re-register the webhook; sweeps cover the gap.`,
      severity: 'warning',
      rateLimitMinutes: minutes,
    });
  }
}

export async function heartbeat(ctx: Ctx, startedAt: Date): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db
    .insert(replicas)
    .values({
      id: ctx.config.replicaId,
      hostname: hostname(),
      version: ctx.config.version,
      startedAt,
      heartbeatAt: now,
    })
    .onConflictDoUpdate({
      target: replicas.id,
      set: { heartbeatAt: now, version: ctx.config.version },
    });
  ctx.telemetry.counter('switchboard.heartbeat', { replica: ctx.config.replicaId });
}
