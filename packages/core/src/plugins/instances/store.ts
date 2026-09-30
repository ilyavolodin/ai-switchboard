import type { Health, InstanceState } from '@ai-switchboard/sdk';
import { and, eq, inArray, type SQL } from 'drizzle-orm';

import type { Clock } from '../../clock.js';
import type { Db } from '../../db/client.js';
import { INSTANCE_TABLES } from '../../db/instance-tables.js';
import { destinations, instanceState, secretProviders, sources } from '../../db/schema.js';
import type { InstanceKind } from '../../domain/status.js';

import type { ResolutionKind } from './kind-specs.js';

/** The columns every instance table has, which is all a build reads. */
export interface InstanceRowHead {
  id: string;
  typeId: string;
  name: string;
  settings: Record<string, unknown>;
  enabled: boolean;
  configVersion: number;
}

export interface RowFilter {
  ids?: readonly string[];
  typeIds?: readonly string[];
}

/** The instance-table reads and writes the host makes (not the API's edits). */
export interface InstanceStore {
  rows(kind: InstanceKind, filter?: RowFilter): Promise<InstanceRowHead[]>;
  versions(kind: InstanceKind): Promise<{ id: string; version: number }[]>;
  health(kind: InstanceKind, id: string): Promise<Health | null>;
  saveHealth(kind: InstanceKind, id: string, health: Health): Promise<void>;
  markSecretsResolved(kind: ResolutionKind, id: string, now: Date): Promise<void>;
  hasSecretProviders(): Promise<boolean>;
  addSecretProvider(typeId: string, now: Date): Promise<void>;
}

export function createInstanceStore(db: Db): InstanceStore {
  return {
    rows: async (kind, filter = {}) => {
      const t = INSTANCE_TABLES[kind];
      if (filter.ids?.length === 0 || filter.typeIds?.length === 0) return [];
      const where: SQL | undefined = filter.ids
        ? inArray(t.id, [...filter.ids])
        : filter.typeIds
          ? inArray(t.typeId, [...filter.typeIds])
          : undefined;
      return db
        .select({
          id: t.id,
          typeId: t.typeId,
          name: t.name,
          settings: t.settings,
          enabled: t.enabled,
          configVersion: t.configVersion,
        })
        .from(t)
        .where(where);
    },
    versions: (kind) => {
      const t = INSTANCE_TABLES[kind];
      return db.select({ id: t.id, version: t.configVersion }).from(t);
    },
    health: async (kind, id) => {
      const t = INSTANCE_TABLES[kind];
      const [row] = await db.select({ health: t.health }).from(t).where(eq(t.id, id));
      return row?.health ?? null;
    },
    saveHealth: async (kind, id, health) => {
      const t = INSTANCE_TABLES[kind];
      await db.update(t).set({ health }).where(eq(t.id, id));
    },
    markSecretsResolved: async (kind, id, now) => {
      const t = kind === 'source' ? sources : destinations;
      await db.update(t).set({ secretsResolvedAt: now }).where(eq(t.id, id));
    },
    hasSecretProviders: async () =>
      (await db.select({ id: secretProviders.id }).from(secretProviders).limit(1)).length > 0,
    addSecretProvider: async (typeId, now) => {
      await db
        .insert(secretProviders)
        .values({
          typeId,
          name: typeId,
          settings: {},
          enabled: true,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    },
  };
}

/** A plugin's `ctx.state`: one row per instance and key. */
export function createInstanceStateStore(db: Db, clock: Clock, instanceId: string): InstanceState {
  return {
    get: async <T>(key: string) => {
      const rows = await db
        .select({ value: instanceState.value })
        .from(instanceState)
        .where(and(eq(instanceState.instanceId, instanceId), eq(instanceState.key, key)));
      return rows[0]?.value as T | undefined;
    },
    set: async (key: string, value: unknown) => {
      await db
        .insert(instanceState)
        .values({ instanceId, key, value, updatedAt: clock.now() })
        .onConflictDoUpdate({
          target: [instanceState.instanceId, instanceState.key],
          set: { value, updatedAt: clock.now() },
        });
    },
  };
}

/** Reads through; every write is dropped (`switchboard doctor`). */
export function readOnlyInstanceStore(store: InstanceStore): InstanceStore {
  return {
    ...store,
    saveHealth: () => Promise.resolve(),
    markSecretsResolved: () => Promise.resolve(),
    addSecretProvider: () => Promise.resolve(),
  };
}
