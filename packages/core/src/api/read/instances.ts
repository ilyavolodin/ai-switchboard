import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';

import { INSTANCE_TABLES } from '../../db/instance-tables.js';
import { destinations, events, runs, sources, type notifiers } from '../../db/schema.js';
import { acceptsUnauthenticated } from '../../domain/authentication.js';
import { instanceErrorText } from '../../domain/instance-error.js';
import { instanceStatus } from '../../domain/labels.js';
import { eventTypesFrom, processReferences } from '../../domain/process.js';
import { collectSecretRefs } from '../../secrets/refs.js';
import { destinationSpecs } from '../../services/destination-specs.js';
import { instanceType } from '../../services/instance-validation.js';
import { LABELS } from '../../services/instances.js';
import { loadProcessRefs, type ProcessRef } from '../../services/process-refs.js';
import type { ApiContext } from '../context.js';
import type { ReadDeps } from './deps.js';
import type {
  DestinationDetail,
  DestinationSummary,
  InstanceSummary,
  SecretRefDTO,
  SourceDetail,
  SourceSummary,
} from '../../contract/index.js';
import { notFound } from '../errors.js';
import { meterGauges } from './meters.js';
import { providerDependents } from './secrets.js';
import { hourOf } from './stats.js';
import { shapeSourceActivity, timeBuckets } from './stats.shape.js';

type SourceRow = typeof sources.$inferSelect;
type DestinationRow = typeof destinations.$inferSelect;

export function secretRefsOf(
  ctx: ReadDeps,
  instanceId: string,
  settings: Record<string, unknown>,
  resolvedAt: Date | null,
): SecretRefDTO[] {
  const error = ctx.runtime.instanceError(instanceId);
  const failed = error?.code === 'secret_error' ? error : undefined;
  return collectSecretRefs(settings).map(({ path, ref }) => ({
    field: path,
    ref,
    lastResolvedAt: resolvedAt?.toISOString() ?? null,
    ok: failed === undefined,
    ...(failed ? { error: failed.message } : {}),
  }));
}

const triggeredBy = (sourceId: string) => (p: ProcessRef) =>
  processReferences(p.document).sources.has(sourceId);
const boundTo = (destinationId: string) => (p: ProcessRef) =>
  p.document.destination.instanceId === destinationId;

export async function sourceSummaries(
  ctx: ReadDeps,
  rows?: SourceRow[],
  processList?: ProcessRef[],
): Promise<SourceSummary[]> {
  const list = rows ?? (await ctx.db.select().from(sources).orderBy(sources.name));
  if (list.length === 0) return [];
  const now = ctx.clock.now();
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const counts = await ctx.db
    .select({
      hour: hourOf(events.receivedAt),
      sourceId: events.sourceId,
      type: events.type,
      stage: events.stage,
      n: count(),
    })
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
    .groupBy(sql`1`, events.sourceId, events.type, events.stage);
  const hours = timeBuckets(since, now, 'hour');
  const procs = processList ?? (await loadProcessRefs(ctx.db));
  return list.map((row) => {
    const typeEntry = ctx.runtime.sourceType(row.typeId);
    const error = ctx.runtime.instanceError(row.id);
    const liveSource = ctx.runtime.source(row.id);
    return {
      id: row.id,
      name: row.name,
      typeId: row.typeId,
      typeName: typeEntry?.type.displayName ?? row.typeId,
      typeIcon: typeEntry?.type.icon ?? null,
      mode: typeEntry?.type.mode ?? 'push',
      enabled: row.enabled,
      status: instanceStatus({ enabled: row.enabled, health: row.health, instanceError: error }),
      health: row.health,
      lastEventAt: row.lastEventAt?.toISOString() ?? null,
      ...shapeSourceActivity(
        hours,
        counts.filter((c) => c.sourceId === row.id),
      ),
      pluginAvailable: typeEntry !== undefined,
      unauthenticated: liveSource
        ? acceptsUnauthenticated(typeEntry?.type, liveSource.source)
        : row.caps.unauthenticated === true,
      processCount: procs.filter(triggeredBy(row.id)).length,
    };
  });
}

export async function sourceDetail(ctx: ReadDeps, id: string): Promise<SourceDetail> {
  const [row] = await ctx.db.select().from(sources).where(eq(sources.id, id));
  if (!row) throw notFound('Source');
  const procs = await loadProcessRefs(ctx.db);
  const [summary] = await sourceSummaries(ctx, [row], procs);
  if (!summary) throw notFound('Source');
  const typeEntry = ctx.runtime.sourceType(row.typeId);
  const live = ctx.runtime.source(id);
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
    instanceError: instanceErrorText(ctx.runtime.instanceError(row.id)),
    processes: procs
      .filter(triggeredBy(row.id))
      .map((p) => ({ id: p.id, name: p.name, eventTypes: eventTypesFrom(p.document, row.id) })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function destinationSummaries(
  ctx: ReadDeps,
  rows?: DestinationRow[],
  processList?: ProcessRef[],
): Promise<DestinationSummary[]> {
  const list = rows ?? (await ctx.db.select().from(destinations).orderBy(destinations.name));
  if (list.length === 0) return [];
  const ids = list.map((e) => e.id);
  const since = new Date(ctx.clock.now().getTime() - 24 * 3_600_000);
  const runCounts = await ctx.db
    .select({ destinationId: runs.destinationId, n: count() })
    .from(runs)
    .where(and(inArray(runs.destinationId, ids), gte(runs.createdAt, since)))
    .groupBy(runs.destinationId);
  const procs = processList ?? (await loadProcessRefs(ctx.db));
  const gauges = await meterGauges(ctx, ids, procs);
  const now = ctx.clock.now().getTime();
  return list.map((row) => {
    const typeEntry = ctx.runtime.destinationType(row.typeId);
    const error = ctx.runtime.instanceError(row.id);
    const mine = gauges.filter((g) => g.destinationId === row.id);
    const softHold = row.softHoldUntil !== null && row.softHoldUntil.getTime() > now;
    return {
      id: row.id,
      name: row.name,
      typeId: row.typeId,
      typeName: typeEntry?.type.displayName ?? row.typeId,
      typeIcon: typeEntry?.type.icon ?? null,
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
      runs24h: runCounts.find((c) => c.destinationId === row.id)?.n ?? 0,
      processCount: procs.filter(boundTo(row.id)).length,
    };
  });
}

export async function destinationDetail(ctx: ReadDeps, id: string): Promise<DestinationDetail> {
  const [row] = await ctx.db.select().from(destinations).where(eq(destinations.id, id));
  if (!row) throw notFound('Destination');
  const procs = await loadProcessRefs(ctx.db);
  const [summary] = await destinationSummaries(ctx, [row], procs);
  if (!summary) throw notFound('Destination');
  const typeEntry = ctx.runtime.destinationType(row.typeId);
  const type = typeEntry?.type;
  const specs = destinationSpecs(ctx.runtime, row);
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
    usage: specs.usage,
    meterSpecs: specs.meters,
    actions: type?.actions ?? [],
    callbackUrl: `${ctx.config.publicUrl}/callbacks/${row.id}`,
    secretRefs: secretRefsOf(ctx, row.id, row.settings, row.secretsResolvedAt),
    instanceError: instanceErrorText(ctx.runtime.instanceError(row.id)),
    processes: procs.filter(boundTo(row.id)).map((p) => ({ id: p.id, name: p.name })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type SimpleKind = 'notifier' | 'secret_provider';

function simpleSummary(
  ctx: ReadDeps,
  kind: SimpleKind,
  row: typeof notifiers.$inferSelect,
): InstanceSummary {
  const type = instanceType(ctx.runtime, kind, row.typeId);
  const error = ctx.runtime.instanceError(row.id);
  return {
    id: row.id,
    kind,
    typeId: row.typeId,
    typeName: type?.displayName ?? row.typeId,
    typeIcon: type?.icon ?? null,
    name: row.name,
    enabled: row.enabled,
    status: instanceStatus({ enabled: row.enabled, health: row.health, instanceError: error }),
    health: row.health,
    settings: row.settings,
    settingsSchema: type?.settingsSchema ?? { type: 'object' },
    instanceError: instanceErrorText(error),
  };
}

/** Notifiers or secret providers, by name; a provider lists the instances that reference it. */
export async function instanceSummaries(
  ctx: ApiContext,
  kind: SimpleKind,
  id?: string,
): Promise<InstanceSummary[]> {
  const table = INSTANCE_TABLES[kind];
  const rows = await ctx.db
    .select()
    .from(table)
    .where(id !== undefined ? eq(table.id, id) : undefined)
    .orderBy(table.name);
  const summaries = rows.map((r) => simpleSummary(ctx, kind, r));
  if (kind !== 'secret_provider') return summaries;
  const dependents = await providerDependents(
    ctx,
    rows.map((r) => r.name),
  );
  return summaries.map((s) => ({ ...s, dependents: dependents.get(s.name) ?? [] }));
}

export async function instanceDetail(
  ctx: ApiContext,
  kind: SimpleKind,
  id: string,
): Promise<InstanceSummary> {
  const [one] = await instanceSummaries(ctx, kind, id);
  if (!one) throw notFound(LABELS[kind]);
  return one;
}
