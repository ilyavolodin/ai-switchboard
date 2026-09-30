import { and, count, eq, gte, inArray, isNull, sql, type AnyColumn } from 'drizzle-orm';

import type { BoardEdge, BoardResponse, StatusStripResponse } from '../../contract/index.js';
import { approvals, dispatches, events, plugins, processes, runs } from '../../db/schema.js';
import { getSettings } from '../../services/settings.js';
import { DAY_MS, MINUTE_MS, msAgo } from '../../util/time.js';
import { attentionItems } from '../../views/attention.js';
import type { ApiContext } from '../context.js';
import type { ReadDeps } from './deps.js';
import { destinationSummaries, sourceSummaries } from './instances.js';
import { meterGauges } from './meters.js';
import { processSummaries } from './processes.js';

/** Of the grouped rows, those at or after `since`: one query for a day and its last minutes. */
const countSince = (col: AnyColumn, since: Date) =>
  sql<number>`count(*) filter (where ${col} >= ${since})`.mapWith(Number);

export async function statusStrip(
  ctx: ReadDeps & Pick<ApiContext, 'oidc'>,
): Promise<StatusStripResponse> {
  const [gauges, breakers, pending] = await Promise.all([
    meterGauges(ctx),
    ctx.db.select({ n: count() }).from(processes).where(eq(processes.breakerState, 'open')),
    ctx.db.select({ n: count() }).from(approvals).where(isNull(approvals.decision)),
  ]);
  return {
    meters: gauges.filter((g) => g.primary),
    openBreakers: breakers[0]?.n ?? 0,
    pendingApprovals: pending[0]?.n ?? 0,
    evaluation: ctx.config.evaluation,
    oidcConfigured: ctx.oidc !== undefined,
  };
}

export async function board(ctx: ReadDeps): Promise<BoardResponse> {
  const now = ctx.clock.now();
  const day = msAgo(now, DAY_MS);
  const recent = msAgo(now, 5 * MINUTE_MS);
  const procRows = await ctx.db.select().from(processes).orderBy(processes.name);
  const [srcs, procs, exs, settings] = await Promise.all([
    sourceSummaries(ctx, undefined, procRows),
    processSummaries(ctx, procRows),
    destinationSummaries(ctx, undefined, procRows),
    getSettings(ctx.db),
  ]);
  const procIds = procRows.map((p) => p.id);

  const [triggered, bound] =
    procIds.length === 0
      ? [[], []]
      : await Promise.all([
          ctx.db
            .select({
              processId: dispatches.processId,
              sourceId: events.sourceId,
              day: count(),
              recent: countSince(dispatches.createdAt, recent),
            })
            .from(dispatches)
            .innerJoin(events, eq(events.id, dispatches.eventId))
            .where(and(inArray(dispatches.processId, procIds), gte(dispatches.createdAt, day)))
            .groupBy(dispatches.processId, events.sourceId),
          ctx.db
            .select({
              processId: runs.processId,
              day: count(),
              recent: countSince(runs.createdAt, recent),
            })
            .from(runs)
            .where(and(inArray(runs.processId, procIds), gte(runs.createdAt, day)))
            .groupBy(runs.processId),
        ]);
  const triggerVolume = new Map(triggered.map((x) => [`${x.processId}:${x.sourceId}`, x]));
  const bindingVolume = new Map(bound.map((x) => [x.processId, x]));

  const edges: BoardEdge[] = [];
  for (const p of procRows) {
    const bySource = new Map<
      string,
      { types: Set<string>; enabled: boolean; describe: string[] }
    >();
    for (const t of p.document.triggers) {
      const e = bySource.get(t.sourceId) ?? {
        types: new Set<string>(),
        enabled: false,
        describe: [],
      };
      t.eventTypes.forEach((x) => e.types.add(x));
      e.enabled ||= t.enabled;
      e.describe.push(t.describe);
      bySource.set(t.sourceId, e);
    }
    for (const [sourceId, e] of bySource) {
      const types = [...e.types];
      const volume = triggerVolume.get(`${p.id}:${sourceId}`);
      edges.push({
        id: `t:${sourceId}:${p.id}`,
        kind: 'trigger',
        from: sourceId,
        to: p.id,
        eventTypes: types,
        label: types.length <= 2 ? types.join(', ') : `${types[0] ?? ''} +${types.length - 1}`,
        volume24h: volume?.day ?? 0,
        recent: volume?.recent ?? 0,
        enabled: e.enabled && p.enabled,
      });
    }
    if (p.document.destination.instanceId) {
      edges.push({
        id: `b:${p.id}:${p.document.destination.instanceId}`,
        kind: 'binding',
        from: p.id,
        to: p.document.destination.instanceId,
        eventTypes: [],
        label: '',
        volume24h: bindingVolume.get(p.id)?.day ?? 0,
        recent: bindingVolume.get(p.id)?.recent ?? 0,
        enabled: p.enabled,
      });
    }
  }

  const idle = procRows.filter((p) => !p.enabled && p.document.triggers.length > 0);
  const [uncertain, turnedAway, failedPlugins] = await Promise.all([
    ctx.db
      .select({ processId: runs.processId, n: count() })
      .from(runs)
      .where(eq(runs.status, 'uncertain'))
      .groupBy(runs.processId),
    turnedAwayByIdle(ctx, idle, day),
    ctx.db
      .select({ name: plugins.name, status: plugins.status })
      .from(plugins)
      .where(inArray(plugins.status, ['failed', 'incompatible'])),
  ]);
  const openedAt = new Map(procRows.map((r) => [r.id, r.breakerOpenedAt]));
  const attention = attentionItems(
    {
      sourceSilenceMinutes: settings.sourceSilenceMinutes,
      processes: procs.map((p) => ({
        ...p,
        breakerOpenedAt: openedAt.get(p.id)?.toISOString() ?? null,
      })),
      sources: srcs,
      destinations: exs,
      uncertain,
      turnedAway,
      failedPlugins,
    },
    now,
  );

  return {
    sources: srcs.map((s) => ({
      id: s.id,
      name: s.name,
      typeId: s.typeId,
      typeName: s.typeName,
      typeIcon: s.typeIcon,
      status: s.status,
      enabled: s.enabled,
      lastEventAt: s.lastEventAt,
      events24h: s.eventsByType24h.reduce((a, b) => a + b.count, 0),
      pluginAvailable: s.pluginAvailable,
      unauthenticated: s.unauthenticated,
    })),
    processes: procs.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      enabled: p.enabled,
      breakerOpen: p.breakerState === 'open',
      awaitingApproval: p.awaitingApproval,
      dots: p.dots,
      nextSweepAt: p.nextSweepAt,
      runs24h: p.dailyCap.used,
      lastRunAt: p.lastRunAt,
    })),
    destinations: exs.map((e) => ({
      id: e.id,
      name: e.name,
      typeId: e.typeId,
      typeName: e.typeName,
      typeIcon: e.typeIcon,
      status: e.status,
      enabled: e.enabled,
      meters: e.meters,
      softHoldUntil: e.softHoldUntil,
    })),
    edges,
    attention,
    generatedAt: now.toISOString(),
  };
}

/**
 * A disabled process that has never run but whose triggers turned events away: most likely
 * created disabled and forgotten. One that ran before was paused on purpose, so it stays quiet.
 */
async function turnedAwayByIdle(
  ctx: ReadDeps,
  idle: { id: string; name: string }[],
  since: Date,
): Promise<{ processId: string; name: string; n: number }[]> {
  if (idle.length === 0) return [];
  const [missed, ran] = await Promise.all([
    ctx.db.execute<{ process_id: string; n: string }>(sql`
      SELECT d->>'processId' AS process_id, count(*)::text AS n
      FROM ${events}, jsonb_array_elements(${events.matchDecisions}) AS d
      WHERE ${events.receivedAt} >= ${since}
        AND d->>'skip' = 'process_disabled'
        AND d->>'processId' IN (${sql.join(
          idle.map((p) => sql`${p.id}`),
          sql`, `,
        )})
      GROUP BY 1`),
    ctx.db
      .selectDistinct({ processId: runs.processId })
      .from(runs)
      .where(
        inArray(
          runs.processId,
          idle.map((p) => p.id),
        ),
      ),
  ]);
  const idleById = new Map(idle.map((p) => [p.id, p]));
  const hasRun = new Set(ran.map((r) => r.processId));
  return missed.rows.flatMap((m) => {
    const p = idleById.get(m.process_id);
    if (!p || hasRun.has(p.id)) return [];
    return [{ processId: p.id, name: p.name, n: Number(m.n) }];
  });
}
