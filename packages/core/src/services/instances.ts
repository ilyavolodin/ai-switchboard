import { eq, sql, type SQL } from 'drizzle-orm';

import type { DbOrTx } from '../db/client.js';
import { destinations, notifiers, secretProviders, sources } from '../db/schema.js';
import type { InstanceKind } from '../plugins/host.js';

/** The columns every instance kind has. */
export interface InstanceHead {
  id: string;
  typeId: string;
  name: string;
  enabled: boolean;
}

const TABLES = {
  source: sources,
  destination: destinations,
  notifier: notifiers,
  secret_provider: secretProviders,
} as const;

/** The shared columns of one instance, or undefined when there is no such row. */
export async function findInstance(
  db: DbOrTx,
  kind: InstanceKind,
  id: string,
): Promise<InstanceHead | undefined> {
  const t = TABLES[kind];
  const [row] = await db
    .select({ id: t.id, typeId: t.typeId, name: t.name, enabled: t.enabled })
    .from(t)
    .where(eq(t.id, id));
  return row;
}

/**
 * `config_version + 1` for an instance table: set it in every write that changes what the plugin
 * host builds the live object from (name, settings, enabled), so every replica rebuilds it on its
 * next reconcile pass.
 */
export function nextConfigVersion(t: (typeof TABLES)[InstanceKind]): SQL {
  return sql`${t.configVersion} + 1`;
}

export async function setInstanceEnabled(
  db: DbOrTx,
  kind: InstanceKind,
  id: string,
  enabled: boolean,
  now: Date,
): Promise<void> {
  const t = TABLES[kind];
  await db
    .update(t)
    .set({ enabled, updatedAt: now, configVersion: nextConfigVersion(t) })
    .where(eq(t.id, id));
}

/**
 * Ask every replica to rebuild an instance (an explicit reload, e.g. after a secret rotated in
 * the backend): the version bump makes each replica's reconcile pass rebuild it, while the replica
 * that handles the request rebuilds it at once.
 */
export async function requestInstanceReload(
  db: DbOrTx,
  kind: InstanceKind,
  id: string,
): Promise<void> {
  const t = TABLES[kind];
  await db
    .update(t)
    .set({ configVersion: nextConfigVersion(t) })
    .where(eq(t.id, id));
}

export async function deleteInstance(db: DbOrTx, kind: InstanceKind, id: string): Promise<void> {
  const t = TABLES[kind];
  await db.delete(t).where(eq(t.id, id));
}

/** Forget a destination's stored health, e.g. the "unhealthy" mark a 401/403 invoke left. */
export async function clearDestinationHealth(db: DbOrTx, id: string): Promise<void> {
  await db.update(destinations).set({ health: null }).where(eq(destinations.id, id));
}
