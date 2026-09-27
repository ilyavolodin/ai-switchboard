import { eq } from 'drizzle-orm';

import type { DbOrTx } from '../db/client.js';
import { executors, notifiers, secretProviders, sources } from '../db/schema.js';
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
  executor: executors,
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

export async function setInstanceEnabled(
  db: DbOrTx,
  kind: InstanceKind,
  id: string,
  enabled: boolean,
  now: Date,
): Promise<void> {
  const t = TABLES[kind];
  await db.update(t).set({ enabled, updatedAt: now }).where(eq(t.id, id));
}

export async function deleteInstance(db: DbOrTx, kind: InstanceKind, id: string): Promise<void> {
  const t = TABLES[kind];
  await db.delete(t).where(eq(t.id, id));
}

/** Forget an executor's stored health, e.g. the "unhealthy" mark a 401/403 invoke left. */
export async function clearExecutorHealth(db: DbOrTx, id: string): Promise<void> {
  await db.update(executors).set({ health: null }).where(eq(executors.id, id));
}
