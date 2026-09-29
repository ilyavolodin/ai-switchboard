import { hostname } from 'node:os';

import { and, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';

import { batches, events, destinations, replicas, sources } from '../../db/schema.js';
import { getSettings } from '../settings.js';

import { JOBS, type Ctx } from './context.js';
import { sendSystemAlert } from './notify.js';
import { recoverRuns } from './runs.js';

/** Every step is safe to run on several replicas at once: claims are conditional updates. */

const DEFAULT_POLL_SECONDS = 300;
const DEFAULT_METER_POLL_SECONDS = 300;

export async function maintenance(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const minuteAgo = new Date(now.getTime() - 60_000);

  const stuckEvents = await ctx.db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.stage, 'received'), lt(events.receivedAt, minuteAgo)))
    .limit(1000);
  for (const e of stuckEvents) await ctx.queue.send(JOBS.match, { eventId: e.id });

  const dueBatches = await ctx.db
    .select({ id: batches.id })
    .from(batches)
    .where(
      and(eq(batches.outcome, 'open'), lt(batches.fireAfter, new Date(now.getTime() - 30_000))),
    )
    .limit(1000);
  for (const b of dueBatches) await ctx.queue.send(JOBS.fire, { batchId: b.id });

  const undispatched = await ctx.db
    .select({ id: batches.id })
    .from(batches)
    .where(and(eq(batches.outcome, 'closed'), lt(batches.closedAt, minuteAgo)))
    .limit(1000);
  for (const b of undispatched) await ctx.queue.send(JOBS.dispatch, { batchId: b.id });

  await recoverRuns(ctx);
  await claimSourcePolls(ctx, now);
  await claimMeterReads(ctx, now);
  await silentSources(ctx, now);
}

async function claimSourcePolls(ctx: Ctx, now: Date): Promise<void> {
  const rows = await ctx.db.select().from(sources).where(eq(sources.enabled, true));
  for (const row of rows) {
    const live = ctx.runtime.source(row.id);
    if (!live?.source.poll || live.type.mode === 'push') continue;
    const interval = Math.max(10, row.caps.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS);
    const claimed = await ctx.db
      .update(sources)
      .set({ lastPolledAt: now })
      .where(
        and(
          eq(sources.id, row.id),
          or(
            isNull(sources.lastPolledAt),
            lte(sources.lastPolledAt, new Date(now.getTime() - interval * 1000)),
          ),
        ),
      )
      .returning({ id: sources.id });
    if (claimed.length > 0) await ctx.queue.send(JOBS.sourcePoll, { sourceId: row.id });
  }
}

async function claimMeterReads(ctx: Ctx, now: Date): Promise<void> {
  const rows = await ctx.db.select().from(destinations).where(eq(destinations.enabled, true));
  for (const row of rows) {
    const live = ctx.runtime.destination(row.id);
    if (!live || live.meters.length === 0) continue;
    const interval = Math.max(30, row.caps.meterPollSeconds ?? DEFAULT_METER_POLL_SECONDS);
    const claimed = await ctx.db
      .update(destinations)
      .set({ metersReadAt: now })
      .where(
        and(
          eq(destinations.id, row.id),
          or(
            isNull(destinations.metersReadAt),
            lte(destinations.metersReadAt, new Date(now.getTime() - interval * 1000)),
          ),
        ),
      )
      .returning({ id: destinations.id });
    if (claimed.length > 0) await ctx.queue.send(JOBS.metersRead, { destinationId: row.id });
  }
}

async function silentSources(ctx: Ctx, now: Date): Promise<void> {
  const settings = await getSettings(ctx.db);
  const minutes = settings.sourceSilenceMinutes;
  if (minutes <= 0) return;
  const cutoff = new Date(now.getTime() - minutes * 60_000);
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
