import { and, count, eq, gte, inArray } from 'drizzle-orm';

import { executors, events, processes, runs, sources } from '../../db/schema.js';
import { instanceStatus } from '../../domain/labels.js';
import type { ProcessDocument } from '../../domain/process.js';
import { collectSecretRefs } from '../../secrets/refs.js';
import type { ApiContext } from '../context.js';
import type {
  ExecutorDetail,
  ExecutorSummary,
  SecretRefDTO,
  SourceDetail,
  SourceSummary,
} from '../contract.js';
import { notFound } from '../errors.js';
import { meterGauges } from './meters.js';

type SourceRow = typeof sources.$inferSelect;
type ExecutorRow = typeof executors.$inferSelect;

export function secretRefsOf(
  ctx: ApiContext,
  instanceId: string,
  settings: Record<string, unknown>,
  resolvedAt: Date | null,
): SecretRefDTO[] {
  const error = ctx.runtime.instanceError(instanceId);
  const failed = error?.startsWith('secret_error') ?? false;
  return collectSecretRefs(settings).map(({ path, ref }) => ({
    field: path,
    ref,
    lastResolvedAt: resolvedAt?.toISOString() ?? null,
    ok: !failed,
    ...(failed && error ? { error: error.replace(/^secret_error: /, '') } : {}),
  }));
}

async function allProcesses(
  ctx: ApiContext,
): Promise<{ id: string; name: string; document: ProcessDocument }[]> {
  return ctx.db
    .select({ id: processes.id, name: processes.name, document: processes.document })
    .from(processes);
}

export async function sourceSummaries(
  ctx: ApiContext,
  rows?: SourceRow[],
): Promise<SourceSummary[]> {
  const list = rows ?? (await ctx.db.select().from(sources).orderBy(sources.name));
  if (list.length === 0) return [];
  const since = new Date(ctx.clock.now().getTime() - 24 * 3_600_000);
  const counts = await ctx.db
    .select({ sourceId: events.sourceId, type: events.type, n: count() })
    .from(events)
    .where(
      and(
        inArray(
          events.sourceId,
          list.map((s) => s.id),
        ),
        gte(events.receivedAt, since),
      ),
    )
    .groupBy(events.sourceId, events.type);
  const procs = await allProcesses(ctx);
  return list.map((row) => {
    const typeEntry = ctx.runtime.sourceType(row.typeId);
    const error = ctx.runtime.instanceError(row.id);
    return {
      id: row.id,
      name: row.name,
      typeId: row.typeId,
      typeName: typeEntry?.type.displayName ?? row.typeId,
      mode: typeEntry?.type.mode ?? 'push',
      enabled: row.enabled,
      status: instanceStatus({ enabled: row.enabled, health: row.health, instanceError: error }),
      health: row.health,
      lastEventAt: row.lastEventAt?.toISOString() ?? null,
      eventsByType24h: counts
        .filter((c) => c.sourceId === row.id)
        .map((c) => ({ type: c.type, count: c.n }))
        .sort((a, b) => b.count - a.count),
      pluginAvailable: typeEntry !== undefined,
      unauthenticated: row.caps.unauthenticated === true,
      processCount: procs.filter((p) => p.document.triggers.some((t) => t.sourceId === row.id))
        .length,
    };
  });
}

export async function sourceDetail(ctx: ApiContext, id: string): Promise<SourceDetail> {
  const [row] = await ctx.db.select().from(sources).where(eq(sources.id, id));
  if (!row) throw notFound('Source');
  const [summary] = await sourceSummaries(ctx, [row]);
  if (!summary) throw notFound('Source');
  const typeEntry = ctx.runtime.sourceType(row.typeId);
  const live = ctx.runtime.source(id);
  const procs = await allProcesses(ctx);
  const isPush = (typeEntry?.type.mode ?? 'push') !== 'pull';
  return {
    ...summary,
    settings: row.settings,
    caps: row.caps,
    webhookUrl: isPush ? `${ctx.config.publicUrl}/hooks/${row.id}` : null,
    pollIntervalSeconds: isPush ? null : (row.caps.pollIntervalSeconds ?? 300),
    provisionSupported: typeof live?.source.provision === 'function',
    provisionedAt: row.provisionedAt?.toISOString() ?? null,
    secretRefs: secretRefsOf(ctx, row.id, row.settings, row.secretsResolvedAt),
    eventTypes: live?.eventTypes ?? typeEntry?.type.eventTypes ?? [],
    actions: typeEntry?.type.actions ?? [],
    settingsSchema: typeEntry?.type.settingsSchema ?? { type: 'object' },
    lastVerifyFailureAt: row.lastVerifyFailureAt?.toISOString() ?? null,
    instanceError: ctx.runtime.instanceError(row.id) ?? null,
    processes: procs
      .filter((p) => p.document.triggers.some((t) => t.sourceId === row.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        eventTypes: [
          ...new Set(
            p.document.triggers.filter((t) => t.sourceId === row.id).flatMap((t) => t.eventTypes),
          ),
        ],
      })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function executorSummaries(
  ctx: ApiContext,
  rows?: ExecutorRow[],
): Promise<ExecutorSummary[]> {
  const list = rows ?? (await ctx.db.select().from(executors).orderBy(executors.name));
  if (list.length === 0) return [];
  const ids = list.map((e) => e.id);
  const since = new Date(ctx.clock.now().getTime() - 24 * 3_600_000);
  const runCounts = await ctx.db
    .select({ executorId: runs.executorId, n: count() })
    .from(runs)
    .where(and(inArray(runs.executorId, ids), gte(runs.createdAt, since)))
    .groupBy(runs.executorId);
  const gauges = await meterGauges(ctx, ids);
  const procs = await allProcesses(ctx);
  const now = ctx.clock.now().getTime();
  return list.map((row) => {
    const typeEntry = ctx.runtime.executorType(row.typeId);
    const error = ctx.runtime.instanceError(row.id);
    const mine = gauges.filter((g) => g.executorId === row.id);
    const softHold = row.softHoldUntil !== null && row.softHoldUntil.getTime() > now;
    return {
      id: row.id,
      name: row.name,
      typeId: row.typeId,
      typeName: typeEntry?.type.displayName ?? row.typeId,
      enabled: row.enabled,
      status: instanceStatus({
        enabled: row.enabled,
        health: row.health,
        instanceError: error,
        softHold,
        stale: mine.some((g) => g.stale && !g.estimated),
      }),
      health: row.health,
      meters: mine,
      softHoldUntil: softHold ? (row.softHoldUntil?.toISOString() ?? null) : null,
      softHoldReason: softHold ? row.softHoldReason : null,
      pluginAvailable: typeEntry !== undefined,
      runs24h: runCounts.find((c) => c.executorId === row.id)?.n ?? 0,
      processCount: procs.filter((p) => p.document.executor.instanceId === row.id).length,
    };
  });
}

export async function executorDetail(ctx: ApiContext, id: string): Promise<ExecutorDetail> {
  const [row] = await ctx.db.select().from(executors).where(eq(executors.id, id));
  if (!row) throw notFound('Executor');
  const [summary] = await executorSummaries(ctx, [row]);
  if (!summary) throw notFound('Executor');
  const typeEntry = ctx.runtime.executorType(row.typeId);
  const live = ctx.runtime.executor(id);
  const type = typeEntry?.type;
  const procs = await allProcesses(ctx);
  return {
    ...summary,
    settings: row.settings,
    targetDefaults: row.targetDefaults,
    caps: row.caps,
    settingsSchema: type?.settingsSchema ?? { type: 'object' },
    targetSchema: type?.targetSchema ?? { type: 'object' },
    inputSchema: type?.inputSchema ?? {},
    tracking: type?.tracking ?? 'none',
    idempotentInvoke: type?.idempotentInvoke ?? false,
    usage: live?.usage ?? type?.usage ?? [],
    meterSpecs: live?.meters ?? type?.meters ?? [],
    actions: type?.actions ?? [],
    callbackUrl: `${ctx.config.publicUrl}/callbacks/${row.id}`,
    secretRefs: secretRefsOf(ctx, row.id, row.settings, row.secretsResolvedAt),
    instanceError: ctx.runtime.instanceError(row.id) ?? null,
    processes: procs
      .filter((p) => p.document.executor.instanceId === row.id)
      .map((p) => ({ id: p.id, name: p.name })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Rows referencing an instance, so a delete can refuse while processes still use it. */
export async function processesUsing(ctx: ApiContext, instanceId: string): Promise<string[]> {
  const procs = await allProcesses(ctx);
  return procs
    .filter(
      (p) =>
        p.document.executor.instanceId === instanceId ||
        p.document.triggers.some((t) => t.sourceId === instanceId) ||
        [...p.document.before, ...p.document.after].some((s) => s.provider === instanceId) ||
        p.document.notify.some((n) => n.notifierId === instanceId),
    )
    .map((p) => p.name);
}
