import { and, count, eq, gte, inArray, isNull } from 'drizzle-orm';

import { approvals, dispatches, events, plugins, processes, runs } from '../../db/schema.js';
import { getSettings } from '../../services/settings.js';
import type { ApiContext } from '../context.js';
import type { AttentionItem, BoardEdge, BoardResponse, StatusStripResponse } from '../contract.js';
import { executorSummaries, sourceSummaries } from './instances.js';
import { meterGauges } from './meters.js';
import { processSummaries } from './processes.js';

export async function statusStrip(ctx: ApiContext): Promise<StatusStripResponse> {
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

export async function board(ctx: ApiContext): Promise<BoardResponse> {
  const now = ctx.clock.now();
  const day = new Date(now.getTime() - 86_400_000);
  const recent = new Date(now.getTime() - 5 * 60_000);
  // One read of the processes table feeds every summary below.
  const procRows = await ctx.db.select().from(processes).orderBy(processes.name);
  const [srcs, procs, exs, settings] = await Promise.all([
    sourceSummaries(ctx, undefined, procRows),
    processSummaries(ctx, procRows),
    executorSummaries(ctx, undefined, procRows),
    getSettings(ctx.db),
  ]);
  const procIds = procRows.map((p) => p.id);

  // Trigger volume: dispatches per (process, source) from events of that source.
  const [trig24, trigRecent, bind24, bindRecent] =
    procIds.length === 0
      ? [[], [], [], []]
      : await Promise.all([
          ctx.db
            .select({ processId: dispatches.processId, sourceId: events.sourceId, n: count() })
            .from(dispatches)
            .innerJoin(events, eq(events.id, dispatches.eventId))
            .where(and(inArray(dispatches.processId, procIds), gte(dispatches.createdAt, day)))
            .groupBy(dispatches.processId, events.sourceId),
          ctx.db
            .select({ processId: dispatches.processId, sourceId: events.sourceId, n: count() })
            .from(dispatches)
            .innerJoin(events, eq(events.id, dispatches.eventId))
            .where(and(inArray(dispatches.processId, procIds), gte(dispatches.createdAt, recent)))
            .groupBy(dispatches.processId, events.sourceId),
          ctx.db
            .select({ processId: runs.processId, n: count() })
            .from(runs)
            .where(and(inArray(runs.processId, procIds), gte(runs.createdAt, day)))
            .groupBy(runs.processId),
          ctx.db
            .select({ processId: runs.processId, n: count() })
            .from(runs)
            .where(and(inArray(runs.processId, procIds), gte(runs.createdAt, recent)))
            .groupBy(runs.processId),
        ]);

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
      edges.push({
        id: `t:${sourceId}:${p.id}`,
        kind: 'trigger',
        from: sourceId,
        to: p.id,
        eventTypes: types,
        label: types.length <= 2 ? types.join(', ') : `${types[0] ?? ''} +${types.length - 1}`,
        volume24h: trig24.find((x) => x.processId === p.id && x.sourceId === sourceId)?.n ?? 0,
        recent: trigRecent.find((x) => x.processId === p.id && x.sourceId === sourceId)?.n ?? 0,
        enabled: e.enabled && p.enabled,
      });
    }
    if (p.document.executor.instanceId) {
      edges.push({
        id: `b:${p.id}:${p.document.executor.instanceId}`,
        kind: 'binding',
        from: p.id,
        to: p.document.executor.instanceId,
        eventTypes: [],
        label: '',
        volume24h: bind24.find((x) => x.processId === p.id)?.n ?? 0,
        recent: bindRecent.find((x) => x.processId === p.id)?.n ?? 0,
        enabled: p.enabled,
      });
    }
  }

  const attention: AttentionItem[] = [];
  for (const p of procs) {
    const row = procRows.find((r) => r.id === p.id);
    if (p.breakerState === 'open') {
      attention.push({
        id: `breaker:${p.id}`,
        kind: 'breaker',
        tone: 'error',
        title: `${p.name}: breaker open`,
        detail: 'Batches and sweeps are held until the breaker is reset or the cooldown passes.',
        targetKind: 'process',
        targetId: p.id,
        action: { id: 'reset_breaker', label: 'Reset' },
        since: row?.breakerOpenedAt?.toISOString() ?? null,
      });
    }
    if (p.awaitingApproval > 0) {
      attention.push({
        id: `approval:${p.id}`,
        kind: 'approval',
        tone: 'warn',
        title: `${p.name}: ${p.awaitingApproval} awaiting approval`,
        detail: 'A person must approve or reject before the run starts.',
        targetKind: 'approval',
        targetId: p.id,
        action: { id: 'open_approvals', label: 'Review' },
        since: null,
      });
    }
  }
  const silenceMs = settings.sourceSilenceMinutes * 60_000;
  for (const s of srcs) {
    if (!s.pluginAvailable) {
      attention.push({
        id: `plugin:${s.id}`,
        kind: 'plugin_unavailable',
        tone: 'warn',
        title: `${s.name}: plugin unavailable`,
        detail: `The ${s.typeId} plugin is not loaded; processes using it are held.`,
        targetKind: 'source',
        targetId: s.id,
        action: { id: 'open', label: 'Open' },
        since: null,
      });
    } else if (s.enabled && s.status.tone === 'error') {
      attention.push({
        id: `unhealthy:${s.id}`,
        kind: 'unhealthy',
        tone: 'error',
        title: `${s.name}: ${s.status.label}`,
        detail: s.health?.message ?? 'The source failed its last health check.',
        targetKind: 'source',
        targetId: s.id,
        action: { id: 'reload', label: 'Reload' },
        since: s.health?.checkedAt ?? null,
      });
    }
    if (s.enabled && s.mode !== 'pull' && s.processCount > 0) {
      const last = s.lastEventAt ? new Date(s.lastEventAt).getTime() : null;
      if (last === null || now.getTime() - last > silenceMs) {
        attention.push({
          id: `silent:${s.id}`,
          kind: 'source_silent',
          tone: 'warn',
          title: `${s.name}: silent`,
          detail:
            last === null ? 'No events received yet.' : 'No events within the silence window.',
          targetKind: 'source',
          targetId: s.id,
          action: { id: 'test_event', label: 'Send test event' },
          since: s.lastEventAt,
        });
      }
    }
  }
  for (const e of exs) {
    if (!e.pluginAvailable) {
      attention.push({
        id: `plugin:${e.id}`,
        kind: 'plugin_unavailable',
        tone: 'warn',
        title: `${e.name}: plugin unavailable`,
        detail: `The ${e.typeId} plugin is not loaded; processes bound to it are held.`,
        targetKind: 'executor',
        targetId: e.id,
        action: { id: 'open', label: 'Open' },
        since: null,
      });
    } else if (e.enabled && e.status.tone === 'error') {
      attention.push({
        id: `unhealthy:${e.id}`,
        kind: 'unhealthy',
        tone: 'error',
        title: `${e.name}: ${e.status.label}`,
        detail: e.health?.message ?? 'Processes bound to it are held.',
        targetKind: 'executor',
        targetId: e.id,
        action: { id: 'reload', label: 'Reload' },
        since: e.health?.checkedAt ?? null,
      });
    }
    for (const m of e.meters) {
      if (e.enabled && m.stale && !m.estimated) {
        attention.push({
          id: `stale:${e.id}:${m.meterId}`,
          kind: 'meter_stale',
          tone: 'warn',
          title: `${e.name}: ${m.title} is stale`,
          detail: m.observedAt
            ? 'Ceilings fall back to run counters until a fresh reading.'
            : 'Never read.',
          targetKind: 'executor',
          targetId: e.id,
          action: { id: 'read_meters', label: 'Read now' },
          since: m.observedAt,
        });
      }
    }
  }
  const uncertain = await ctx.db
    .select({ processId: runs.processId, n: count() })
    .from(runs)
    .where(eq(runs.status, 'uncertain'))
    .groupBy(runs.processId);
  for (const u of uncertain) {
    const p = procs.find((x) => x.id === u.processId);
    attention.push({
      id: `uncertain:${u.processId}`,
      kind: 'uncertain_runs',
      tone: 'warn',
      title: `${p?.name ?? 'A process'}: ${u.n} uncertain run${u.n === 1 ? '' : 's'}`,
      detail:
        'The invoke response was lost; tracking will settle it or the deadline marks it unknown.',
      targetKind: 'process',
      targetId: u.processId,
      action: { id: 'open', label: 'Open' },
      since: null,
    });
  }
  const failed = await ctx.db
    .select({ name: plugins.name, status: plugins.status })
    .from(plugins)
    .where(inArray(plugins.status, ['failed', 'incompatible']));
  for (const f of failed) {
    attention.push({
      id: `pluginload:${f.name}`,
      kind: 'plugin_unavailable',
      tone: 'error',
      title: `${f.name}: ${f.status}`,
      detail: 'The plugin failed to load.',
      targetKind: 'plugin',
      targetId: f.name,
      action: { id: 'open', label: 'Open' },
      since: null,
    });
  }

  const toneRank = { error: 0, warn: 1, ok: 2, off: 3 } as const;
  attention.sort((a, b) => toneRank[a.tone] - toneRank[b.tone]);

  return {
    sources: srcs.map((s) => ({
      id: s.id,
      name: s.name,
      typeId: s.typeId,
      typeName: s.typeName,
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
    executors: exs.map((e) => ({
      id: e.id,
      name: e.name,
      typeId: e.typeId,
      typeName: e.typeName,
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
