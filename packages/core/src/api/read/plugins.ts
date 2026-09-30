import { count, eq } from 'drizzle-orm';

import { INSTANCE_TABLES } from '../../db/instance-tables.js';
import { plugins, pluginTypes } from '../../db/schema.js';
import { pluginStatusLabel } from '../../domain/labels.js';
import { INSTANCE_KINDS } from '../../domain/status.js';
import { listInstalled, type InstalledPlugin } from '../../plugins/install.js';
import { pluginKindOf } from '../../plugins/naming.js';
import type { RegistryPackage } from '../../plugins/search.js';
import { CATALOGUE } from '../../services/catalogue.js';
import type { ApiContext } from '../context.js';
import type {
  CatalogueEntry,
  PluginKind,
  PluginSearchResult,
  PluginSummary,
  PluginTypeDTO,
} from '../../contract/index.js';

export function typeDTO(kind: PluginKind, row: typeof pluginTypes.$inferSelect): PluginTypeDTO {
  const m = row.manifest;
  return {
    kind,
    typeId: row.typeId,
    displayName: row.displayName,
    ...(typeof m.description === 'string' ? { description: m.description } : {}),
    ...(typeof m.icon === 'string' ? { icon: m.icon } : {}),
    plugin: row.plugin,
    available: row.available,
    settingsSchema: (m.settingsSchema as PluginTypeDTO['settingsSchema'] | undefined) ?? {
      type: 'object',
    },
    ...(kind === 'source'
      ? {
          mode: m.mode as PluginTypeDTO['mode'],
          eventTypes: (m.eventTypes as PluginTypeDTO['eventTypes']) ?? [],
          dynamicEventTypes: m.dynamicEventTypes === true,
          allowsUnauthenticated: m.allowsUnauthenticated === true,
          actions: (m.actions as PluginTypeDTO['actions']) ?? [],
        }
      : {}),
    ...(kind === 'destination'
      ? {
          targetSchema: m.targetSchema as PluginTypeDTO['targetSchema'],
          inputSchema: m.inputSchema as PluginTypeDTO['inputSchema'],
          tracking: m.tracking as PluginTypeDTO['tracking'],
          idempotentInvoke: m.idempotentInvoke === true,
          usage: (m.usage as PluginTypeDTO['usage']) ?? [],
          meters: (m.meters as PluginTypeDTO['meters']) ?? [],
          examples: (m.examples as PluginTypeDTO['examples']) ?? [],
          actions: (m.actions as PluginTypeDTO['actions']) ?? [],
        }
      : {}),
  };
}

export async function pluginTypeList(
  ctx: ApiContext,
  kind: PluginKind | undefined,
): Promise<PluginTypeDTO[]> {
  const rows = await ctx.db
    .select()
    .from(pluginTypes)
    .where(kind ? eq(pluginTypes.kind, kind) : undefined)
    .orderBy(pluginTypes.displayName);
  return rows.map((r) => typeDTO(r.kind, r));
}

/** `kind:typeId` → how many instances use the type. */
async function instanceCounts(ctx: ApiContext): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const kind of INSTANCE_KINDS) {
    const t = INSTANCE_TABLES[kind];
    const rows = await ctx.db.select({ typeId: t.typeId, n: count() }).from(t).groupBy(t.typeId);
    for (const r of rows) out.set(`${kind}:${r.typeId}`, r.n);
  }
  return out;
}

function installedOn(ctx: ApiContext): Promise<InstalledPlugin[]> {
  return listInstalled(ctx.config.home).catch(() => []);
}

export async function pluginSummaries(ctx: ApiContext): Promise<PluginSummary[]> {
  const [rows, types, counts, lock] = await Promise.all([
    ctx.db.select().from(plugins).orderBy(plugins.displayName),
    ctx.db.select().from(pluginTypes),
    instanceCounts(ctx),
    installedOn(ctx),
  ]);
  // A removed plugin leaves the list once this replica's copy is gone (its row stays as the
  // tombstone other replicas act on).
  const listed = rows.filter(
    (p) => p.removeRequestedAt === null || lock.some((l) => l.name === p.name),
  );
  const summaries: PluginSummary[] = listed.map((p) => {
    const locked = lock.find((l) => l.name === p.name);
    const pendingRestart =
      p.origin === 'installed' && locked !== undefined && locked.version !== p.version;
    return {
      name: p.name,
      pluginId: p.pluginId,
      displayName: p.displayName,
      version: p.version,
      status: p.status,
      statusLabel: pendingRestart
        ? { tone: 'warn', label: 'restart to apply' }
        : pluginStatusLabel(p.status),
      statusMessage: pendingRestart
        ? `Version ${locked.version} is installed; restart to load it.`
        : p.statusMessage,
      origin: p.origin,
      sdkRange: p.sdkRange,
      capabilities: p.capabilities,
      types: types
        .filter((t) => t.plugin === p.name)
        .map((t) => ({
          kind: t.kind,
          typeId: t.typeId,
          displayName: t.displayName,
          instanceCount: counts.get(`${t.kind}:${t.typeId}`) ?? 0,
        })),
      errorCount: p.errorCount,
      invalidEventCount: p.invalidEventCount,
      integrity: locked?.integrity ?? p.integrity,
      pendingRestart,
    };
  });
  // Added with the CLI since the last start: in the lockfile, not yet loaded.
  for (const l of lock) {
    if (rows.some((r) => r.name === l.name)) continue;
    summaries.push({
      name: l.name,
      pluginId: l.name,
      displayName: l.name,
      version: l.version,
      status: 'unavailable',
      statusLabel: { tone: 'warn', label: 'restart to load' },
      statusMessage: 'Installed; the host loads it on the next start.',
      origin: 'installed',
      sdkRange: l.sdk,
      capabilities: {},
      types: [],
      errorCount: 0,
      invalidEventCount: 0,
      integrity: l.integrity,
      pendingRestart: true,
    });
  }
  return summaries;
}

export async function pluginSummary(
  ctx: ApiContext,
  name: string,
): Promise<PluginSummary | undefined> {
  return (await pluginSummaries(ctx)).find((p) => p.name === name);
}

/** Registry hits, marked installed (loaded, or waiting for a restart) and reviewed. */
export async function searchResults(
  ctx: ApiContext,
  found: RegistryPackage[],
): Promise<PluginSearchResult[]> {
  const [rows, lock] = await Promise.all([
    ctx.db
      .select({ name: plugins.name, version: plugins.version, status: plugins.status })
      .from(plugins),
    installedOn(ctx),
  ]);
  const reviewed = new Set(CATALOGUE.map((c) => c.package));
  return found.map((pkg) => {
    const row = rows.find((r) => r.name === pkg.name && r.status === 'loaded');
    const locked = lock.find((l) => l.name === pkg.name);
    const installedVersion = locked?.version ?? row?.version ?? null;
    return {
      package: pkg.name,
      kind: pluginKindOf(pkg.kind),
      version: pkg.version,
      description: pkg.description,
      publisher: pkg.publisher,
      date: pkg.date,
      links: pkg.links,
      weeklyDownloads: pkg.weeklyDownloads,
      installed: installedVersion !== null,
      installedVersion,
      reviewed: reviewed.has(pkg.name),
    };
  });
}

export async function catalogue(ctx: ApiContext): Promise<CatalogueEntry[]> {
  const rows = await ctx.db.select({ name: plugins.name, status: plugins.status }).from(plugins);
  return CATALOGUE.map((c) => ({
    ...c,
    installed: rows.some((r) => r.name === c.package && r.status === 'loaded'),
  }));
}
