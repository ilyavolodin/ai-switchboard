import { and, eq, isNotNull, or, sql } from 'drizzle-orm';

import type { Db, DbOrTx } from '../db/client.js';
import { plugins, pluginTypes } from '../db/schema.js';

import type { EvaluatedPlugin } from './loader.js';
import { serializeType } from './manifest.js';
import type { RegisteredType } from './type-registry.js';

export const REMOVED_MESSAGE = 'removed by an admin';

export interface InstallRecord {
  name: string;
  installSpec: string | null;
  installVersion: string | null;
  removeRequestedAt: Date | null;
}

export interface PluginErrorCounts {
  exception: number;
  invalid_event: number;
  invalid_usage: number;
}

/** Every write to `plugins` and `plugin_types`. */
export interface PluginCatalog {
  /** At boot: every evaluated package, and the types of the ones that loaded. */
  replaceLoaded(
    loaded: readonly { plugin: EvaluatedPlugin; sdkRange: string }[],
    types: readonly RegisteredType[],
    now: Date,
  ): Promise<void>;
  /** A hot-loaded package and its types. */
  upsertLoaded(
    plugin: EvaluatedPlugin,
    sdkRange: string,
    types: readonly RegisteredType[],
    now: Date,
  ): Promise<void>;
  /** The row may not exist yet on this replica. Clears a removal tombstone. */
  recordInstall(
    install: { name: string; spec: string; version: string; sdkRange: string },
    now: Date,
  ): Promise<void>;
  /** Every replica's sync pass removes its own copy. */
  tombstone(name: string, now: Date): Promise<void>;
  markRemoved(name: string, now: Date): Promise<void>;
  addErrorCounts(name: string, counts: PluginErrorCounts): Promise<void>;
  readInstallRecords(): Promise<InstallRecord[]>;
}

/** Install columns are left alone. */
function pluginRow(p: EvaluatedPlugin, sdkRange: string, now: Date) {
  const def = p.definition;
  return {
    name: p.name,
    pluginId: def?.id ?? p.name,
    displayName: def?.displayName ?? p.name,
    version: p.version,
    sdkRange,
    capabilities: def?.capabilities ?? {},
    status: p.status,
    statusMessage: p.message ?? null,
    origin: p.origin,
    loadedAt: p.status === 'loaded' ? now : null,
    updatedAt: now,
  };
}

function typeRow(t: RegisteredType, now: Date) {
  return {
    plugin: t.pluginName,
    kind: t.kind,
    typeId: t.typeId,
    displayName: t.type.displayName,
    manifest: serializeType(t.kind, t.type),
    available: true,
    updatedAt: now,
  };
}

async function upsertPlugin(tx: DbOrTx, p: EvaluatedPlugin, sdkRange: string, now: Date) {
  const values = pluginRow(p, sdkRange, now);
  await tx.insert(plugins).values(values).onConflictDoUpdate({ target: plugins.name, set: values });
}

async function upsertTypes(tx: DbOrTx, types: readonly RegisteredType[], now: Date) {
  for (const t of types) {
    const values = typeRow(t, now);
    await tx
      .insert(pluginTypes)
      .values(values)
      .onConflictDoUpdate({ target: [pluginTypes.kind, pluginTypes.typeId], set: values });
  }
}

export function createPluginCatalog(db: Db): PluginCatalog {
  return {
    replaceLoaded: (loaded, types, now) =>
      db.transaction(async (tx) => {
        const present = new Set<string>();
        for (const { plugin, sdkRange } of loaded) {
          present.add(plugin.name);
          await upsertPlugin(tx, plugin, sdkRange, now);
        }
        const rows = await tx
          .select({ name: plugins.name, removeRequestedAt: plugins.removeRequestedAt })
          .from(plugins);
        for (const row of rows) {
          if (present.has(row.name)) continue;
          await tx
            .update(plugins)
            .set({
              status: 'unavailable',
              statusMessage: row.removeRequestedAt ? REMOVED_MESSAGE : 'package not found at boot',
              loadedAt: null,
              updatedAt: now,
            })
            .where(eq(plugins.name, row.name));
        }
        await tx.update(pluginTypes).set({ available: false, updatedAt: now });
        await upsertTypes(tx, types, now);
      }),
    upsertLoaded: (plugin, sdkRange, types, now) =>
      db.transaction(async (tx) => {
        await upsertPlugin(tx, plugin, sdkRange, now);
        await upsertTypes(tx, types, now);
      }),
    recordInstall: async ({ name, spec, version, sdkRange }, now) => {
      const install = {
        installSpec: spec,
        installVersion: version,
        installedAt: now,
        removeRequestedAt: null,
      };
      await db
        .insert(plugins)
        .values({
          name,
          pluginId: name,
          displayName: name,
          version,
          sdkRange,
          status: 'unavailable',
          statusMessage: 'installed; loading',
          origin: 'installed',
          ...install,
          updatedAt: now,
        })
        .onConflictDoUpdate({ target: plugins.name, set: { ...install, origin: 'installed' } });
    },
    tombstone: async (name, now) => {
      await db
        .update(plugins)
        .set({ installSpec: null, installVersion: null, removeRequestedAt: now, updatedAt: now })
        .where(eq(plugins.name, name));
    },
    markRemoved: (name, now) =>
      db.transaction(async (tx) => {
        await tx
          .update(plugins)
          .set({
            status: 'unavailable',
            statusMessage: REMOVED_MESSAGE,
            loadedAt: null,
            updatedAt: now,
          })
          .where(and(eq(plugins.name, name), isNotNull(plugins.removeRequestedAt)));
        await tx
          .update(pluginTypes)
          .set({ available: false, updatedAt: now })
          .where(eq(pluginTypes.plugin, name));
      }),
    addErrorCounts: async (name, c) => {
      await db
        .update(plugins)
        .set({
          errorCount: sql`${plugins.errorCount} + ${c.exception + c.invalid_usage}`,
          invalidEventCount: sql`${plugins.invalidEventCount} + ${c.invalid_event}`,
        })
        .where(eq(plugins.name, name));
    },
    readInstallRecords: () =>
      db
        .select({
          name: plugins.name,
          installSpec: plugins.installSpec,
          installVersion: plugins.installVersion,
          removeRequestedAt: plugins.removeRequestedAt,
        })
        .from(plugins)
        .where(or(isNotNull(plugins.installSpec), isNotNull(plugins.removeRequestedAt))),
  };
}

/** For a host that inspects without writing (`switchboard doctor`). */
export const readOnlyPluginCatalog: PluginCatalog = {
  replaceLoaded: () => Promise.resolve(),
  upsertLoaded: () => Promise.resolve(),
  recordInstall: () => Promise.resolve(),
  tombstone: () => Promise.resolve(),
  markRemoved: () => Promise.resolve(),
  addErrorCounts: () => Promise.resolve(),
  readInstallRecords: () => Promise.resolve([]),
};
