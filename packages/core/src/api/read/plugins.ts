import { count, eq } from 'drizzle-orm';

import type {
  CatalogueEntry,
  PluginKind,
  PluginSearchResult,
  PluginSummary,
  PluginTypeDTO,
} from '../../contract/index.js';
import { selectFromEachInstanceTable } from '../../db/instance-tables.js';
import { plugins, pluginTypes } from '../../db/schema.js';
import { pluginStatusLabel } from '../../domain/labels.js';
import { INSTANCE_KINDS } from '../../domain/status.js';
import { listInstalled, type InstalledPlugin } from '../../plugins/install.js';
import { pluginKindOf } from '../../plugins/naming.js';
import type { RegistryPackage } from '../../plugins/search.js';
import { CATALOGUE } from '../../services/catalogue.js';
import { groupBy } from '../../util/collections.js';
import type { ReadDeps } from './deps.js';

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
  ctx: ReadDeps,
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
async function instanceCounts(ctx: ReadDeps): Promise<Map<string, number>> {
  const rows = await selectFromEachInstanceTable(INSTANCE_KINDS, (t) =>
    ctx.db.select({ typeId: t.typeId, n: count() }).from(t).groupBy(t.typeId),
  );
  return new Map(rows.map((r) => [`${r.kind}:${r.typeId}`, r.n]));
}

function installedOn(ctx: ReadDeps): Promise<InstalledPlugin[]> {
  return listInstalled(ctx.config.home).catch(() => []);
}

/** Every plugin, or only the one named. */
export async function pluginSummaries(ctx: ReadDeps, name?: string): Promise<PluginSummary[]> {
  const [rows, types, counts, installed] = await Promise.all([
    ctx.db
      .select()
      .from(plugins)
      .where(name === undefined ? undefined : eq(plugins.name, name))
      .orderBy(plugins.displayName),
    ctx.db
      .select()
      .from(pluginTypes)
      .where(name === undefined ? undefined : eq(pluginTypes.plugin, name)),
    instanceCounts(ctx),
    installedOn(ctx),
  ]);
  const lock = name === undefined ? installed : installed.filter((l) => l.name === name);
  const lockedByName = new Map(lock.map((l) => [l.name, l]));
  const typesOf = groupBy(types, (t) => t.plugin);
  // A removed plugin leaves the list once this replica's copy is gone (its row stays as the
  // tombstone other replicas act on).
  const listed = rows.filter((p) => p.removeRequestedAt === null || lockedByName.has(p.name));
  const summaries: PluginSummary[] = listed.map((p) => {
    const locked = lockedByName.get(p.name);
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
      types: (typesOf.get(p.name) ?? []).map((t) => ({
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
  const known = new Set(rows.map((r) => r.name));
  for (const l of lock) {
    if (known.has(l.name)) continue;
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
  ctx: ReadDeps,
  name: string,
): Promise<PluginSummary | undefined> {
  const [one] = await pluginSummaries(ctx, name);
  return one;
}

/** Registry hits, marked installed (loaded, or waiting for a restart) and reviewed. */
export async function searchResults(
  ctx: ReadDeps,
  found: RegistryPackage[],
): Promise<PluginSearchResult[]> {
  const [rows, lock] = await Promise.all([
    ctx.db
      .select({ name: plugins.name, version: plugins.version, status: plugins.status })
      .from(plugins),
    installedOn(ctx),
  ]);
  const reviewed = new Set(CATALOGUE.map((c) => c.package));
  const loaded = new Map(rows.filter((r) => r.status === 'loaded').map((r) => [r.name, r]));
  const locked = new Map(lock.map((l) => [l.name, l]));
  return found.map((pkg) => {
    const installedVersion = locked.get(pkg.name)?.version ?? loaded.get(pkg.name)?.version ?? null;
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

export async function catalogue(ctx: ReadDeps): Promise<CatalogueEntry[]> {
  const rows = await ctx.db
    .select({ name: plugins.name })
    .from(plugins)
    .where(eq(plugins.status, 'loaded'));
  const loaded = new Set(rows.map((r) => r.name));
  return CATALOGUE.map((c) => ({ ...c, installed: loaded.has(c.package) }));
}
