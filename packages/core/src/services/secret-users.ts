import type { Health } from '@ai-switchboard/sdk';

import type { SecretUserDTO } from '../contract/index.js';
import type { DbOrTx } from '../db/client.js';
import { INSTANCE_TABLES } from '../db/instance-tables.js';
import { INSTANCE_KINDS, type InstanceKind } from '../domain/status.js';
import { collectDocumentSecretRefs, collectSecretRefs, parseSecretRef } from '../secrets/refs.js';
import { loadProcessRefs } from './process-refs.js';

export interface SecretReference {
  /** Dotted path of the field holding it. */
  path: string;
  provider: string;
  name: string;
}

/** An instance or a process and the `secret://` references it holds. */
export interface SecretHolder {
  kind: InstanceKind | 'process';
  id: string;
  name: string;
  enabled: boolean;
  health: Health | null;
  refs: SecretReference[];
}

/**
 * Every `secret://<provider>/<name>` reference in stored settings (every instance kind, secret
 * providers included) and in process documents (`$secretRef('<provider>/<name>')`), in name order.
 */
export async function secretRefIndex(db: DbOrTx): Promise<SecretHolder[]> {
  const parse = (found: { path: string; ref: string }[]): SecretReference[] =>
    found.flatMap(({ path, ref }) => {
      const parsed = parseSecretRef(ref);
      return parsed ? [{ path, provider: parsed.provider, name: parsed.name }] : [];
    });
  const out: SecretHolder[] = [];
  for (const kind of INSTANCE_KINDS) {
    const table = INSTANCE_TABLES[kind];
    const rows = await db
      .select({
        id: table.id,
        name: table.name,
        enabled: table.enabled,
        health: table.health,
        settings: table.settings,
      })
      .from(table)
      .orderBy(table.name);
    for (const r of rows) {
      out.push({
        kind,
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        health: r.health,
        refs: parse(collectSecretRefs(r.settings)),
      });
    }
  }
  for (const p of await loadProcessRefs(db)) {
    out.push({
      kind: 'process',
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      health: null,
      refs: parse(collectDocumentSecretRefs(p.document)),
    });
  }
  return out;
}

/** Who references each secret name of `provider`. */
export function usersByName(
  index: readonly SecretHolder[],
  provider: string,
): Map<string, SecretUserDTO[]> {
  const byName = new Map<string, SecretUserDTO[]>();
  for (const holder of index) {
    for (const ref of holder.refs) {
      if (ref.provider !== provider) continue;
      const list = byName.get(ref.name) ?? [];
      list.push({ kind: holder.kind, id: holder.id, name: holder.name, field: ref.path });
      byName.set(ref.name, list);
    }
  }
  return byName;
}

export async function secretUsersByName(
  db: DbOrTx,
  provider: string,
): Promise<Map<string, SecretUserDTO[]>> {
  return usersByName(await secretRefIndex(db), provider);
}

/** The holders referencing each of `providerNames`, each holder once per provider. */
export function holdersByProvider(
  index: readonly SecretHolder[],
  providerNames: readonly string[],
): Map<string, SecretHolder[]> {
  const out = new Map<string, SecretHolder[]>(providerNames.map((n) => [n, []]));
  for (const holder of index) {
    for (const provider of new Set(holder.refs.map((r) => r.provider))) {
      out.get(provider)?.push(holder);
    }
  }
  return out;
}

const USER_ORDER: readonly SecretUserDTO['kind'][] = ['process', ...INSTANCE_KINDS];

/** For the 409 that refuses to delete a provider still in use; the provider itself is left out. */
export async function providerUsers(
  db: DbOrTx,
  provider: string,
  selfId: string,
): Promise<Pick<SecretUserDTO, 'kind' | 'id' | 'name'>[]> {
  const holders = holdersByProvider(await secretRefIndex(db), [provider]).get(provider) ?? [];
  return holders
    .filter((h) => h.id !== selfId)
    .map(({ kind, id, name }) => ({ kind, id, name }))
    .sort(
      (a, b) =>
        USER_ORDER.indexOf(a.kind) - USER_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
    );
}
