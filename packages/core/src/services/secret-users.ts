import type { SecretUserDTO } from '../contract/index.js';
import type { DbOrTx } from '../db/client.js';
import { INSTANCE_TABLES } from '../db/instance-tables.js';
import { INSTANCE_KINDS } from '../domain/status.js';
import { collectDocumentSecretRefs, collectSecretRefs, parseSecretRef } from '../secrets/refs.js';
import { loadProcessRefs } from './process-refs.js';

/** Every `secret://<provider>/…` reference in stored settings and process documents, by name. */
export async function secretUsersByName(
  db: DbOrTx,
  provider: string,
): Promise<Map<string, SecretUserDTO[]>> {
  const rows: {
    kind: SecretUserDTO['kind'];
    id: string;
    name: string;
    refs: { path: string; ref: string }[];
  }[] = [];
  for (const kind of INSTANCE_KINDS) {
    const table = INSTANCE_TABLES[kind];
    const found = await db
      .select({ id: table.id, name: table.name, settings: table.settings })
      .from(table);
    for (const r of found)
      rows.push({ kind, id: r.id, name: r.name, refs: collectSecretRefs(r.settings) });
  }
  for (const p of await loadProcessRefs(db)) {
    // Expressions reference secrets too: `$secretRef('<provider>/<name>')`.
    rows.push({
      kind: 'process',
      id: p.id,
      name: p.name,
      refs: collectDocumentSecretRefs(p.document),
    });
  }

  const byName = new Map<string, SecretUserDTO[]>();
  for (const row of rows) {
    for (const { path, ref } of row.refs) {
      const parsed = parseSecretRef(ref);
      if (parsed?.provider !== provider) continue;
      const list = byName.get(parsed.name) ?? [];
      list.push({ kind: row.kind, id: row.id, name: row.name, field: path });
      byName.set(parsed.name, list);
    }
  }
  return byName;
}

const USER_ORDER: readonly SecretUserDTO['kind'][] = ['process', ...INSTANCE_KINDS];

/** For the 409 that refuses to delete a provider still in use; the provider itself is left out. */
export async function providerUsers(
  db: DbOrTx,
  provider: string,
  selfId: string,
): Promise<Pick<SecretUserDTO, 'kind' | 'id' | 'name'>[]> {
  const seen = new Map<string, Pick<SecretUserDTO, 'kind' | 'id' | 'name'>>();
  for (const list of (await secretUsersByName(db, provider)).values()) {
    for (const u of list) {
      if (u.id !== selfId) seen.set(`${u.kind}:${u.id}`, { kind: u.kind, id: u.id, name: u.name });
    }
  }
  return [...seen.values()].sort(
    (a, b) =>
      USER_ORDER.indexOf(a.kind) - USER_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
  );
}
