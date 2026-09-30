import type { InstanceKind } from '../domain/status.js';

import { destinations, notifiers, secretProviders, sources } from './schema.js';

export const INSTANCE_TABLES = {
  source: sources,
  destination: destinations,
  notifier: notifiers,
  secret_provider: secretProviders,
} as const satisfies Record<InstanceKind, unknown>;

export type InstanceTable = (typeof INSTANCE_TABLES)[InstanceKind];

export type InstanceRow<K extends InstanceKind> = (typeof INSTANCE_TABLES)[K]['$inferSelect'];

/** Runs `select` against each kind's table in parallel; rows come back tagged with their kind. */
export async function selectFromEachInstanceTable<K extends InstanceKind, R>(
  kinds: readonly K[],
  select: (table: InstanceTable, kind: K) => Promise<R[]>,
): Promise<(R & { kind: K })[]> {
  const lists = await Promise.all(
    kinds.map(async (kind) =>
      (await select(INSTANCE_TABLES[kind], kind)).map((row) => ({ ...row, kind })),
    ),
  );
  return lists.flat();
}
