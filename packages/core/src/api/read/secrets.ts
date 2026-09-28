import type { SecretListing } from '@ai-switchboard/sdk';
import { eq } from 'drizzle-orm';

import { executors, notifiers, processes, secretProviders, sources } from '../../db/schema.js';
import { instanceStatus } from '../../domain/labels.js';
import {
  collectDocumentSecretRefs,
  collectSecretRefs,
  formatSecretRef,
  parseSecretRef,
} from '../../secrets/refs.js';
import type { ApiContext } from '../context.js';
import type {
  MissingSecretDTO,
  ProviderSecretDTO,
  ProviderSecretsResponse,
  SecretProviderDependentDTO,
  SecretUserDTO,
} from '../contract.js';
import { notFound } from '../errors.js';

/** How long a provider's `list()` may take before the listing is reported unavailable. */
const LIST_TIMEOUT_MS = 10_000;

/** Every `secret://<provider>/…` reference in stored settings and process documents, by name. */
async function usersByName(
  ctx: ApiContext,
  provider: string,
): Promise<Map<string, SecretUserDTO[]>> {
  const { db } = ctx;
  const rows: {
    kind: SecretUserDTO['kind'];
    id: string;
    name: string;
    refs: { path: string; ref: string }[];
  }[] = [];
  const tables = [
    ['source', sources],
    ['executor', executors],
    ['notifier', notifiers],
    ['secret_provider', secretProviders],
  ] as const;
  for (const [kind, table] of tables) {
    const found = await db
      .select({ id: table.id, name: table.name, settings: table.settings })
      .from(table);
    for (const r of found)
      rows.push({ kind, id: r.id, name: r.name, refs: collectSecretRefs(r.settings) });
  }
  for (const p of await db
    .select({ id: processes.id, name: processes.name, document: processes.document })
    .from(processes)) {
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

/**
 * Everything that references `secret://<provider>/…`, one entry per instance or process, for
 * the 409 that refuses to delete a provider still in use. The provider itself is left out.
 */
export async function providerUsers(
  ctx: ApiContext,
  provider: string,
  selfId: string,
): Promise<Pick<SecretUserDTO, 'kind' | 'id' | 'name'>[]> {
  const seen = new Map<string, Pick<SecretUserDTO, 'kind' | 'id' | 'name'>>();
  for (const list of (await usersByName(ctx, provider)).values()) {
    for (const u of list) {
      if (u.id !== selfId) seen.set(`${u.kind}:${u.id}`, { kind: u.kind, id: u.id, name: u.name });
    }
  }
  const order: SecretUserDTO['kind'][] = [
    'process',
    'source',
    'executor',
    'notifier',
    'secret_provider',
  ];
  return [...seen.values()].sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name),
  );
}

/**
 * The sources, executors and notifiers whose settings reference each provider name, with the
 * status they have now (so right after a rebuild, the result of it).
 */
export async function providerDependents(
  ctx: ApiContext,
  providerNames: readonly string[],
): Promise<Map<string, SecretProviderDependentDTO[]>> {
  const out = new Map<string, SecretProviderDependentDTO[]>(providerNames.map((n) => [n, []]));
  if (providerNames.length === 0) return out;
  const tables = [
    ['source', sources],
    ['executor', executors],
    ['notifier', notifiers],
  ] as const;
  for (const [kind, table] of tables) {
    const rows = await ctx.db
      .select({
        id: table.id,
        name: table.name,
        enabled: table.enabled,
        health: table.health,
        settings: table.settings,
      })
      .from(table)
      .orderBy(table.name);
    for (const row of rows) {
      const providers = new Set(
        collectSecretRefs(row.settings).flatMap((r) => parseSecretRef(r.ref)?.provider ?? []),
      );
      for (const provider of providers) {
        const list = out.get(provider);
        if (!list) continue;
        const error = ctx.runtime.instanceError(row.id);
        list.push({
          kind,
          id: row.id,
          name: row.name,
          status: instanceStatus({
            enabled: row.enabled,
            health: row.health,
            instanceError: error,
          }),
          instanceError: error ?? null,
        });
      }
    }
  }
  return out;
}

/**
 * Keep only the fields the contract allows, so a provider that returns more (a value, by
 * mistake) cannot push it through the API. Entries without a usable name are dropped.
 */
function sanitize(listing: unknown): SecretListing[] {
  if (!Array.isArray(listing)) throw new Error('list() did not return an array');
  const seen = new Set<string>();
  const out: SecretListing[] = [];
  for (const entry of listing as unknown[]) {
    if (entry === null || typeof entry !== 'object') continue;
    const { name, description, updatedAt } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      ...(typeof description === 'string' && description !== '' ? { description } : {}),
      ...(typeof updatedAt === 'string' && !Number.isNaN(Date.parse(updatedAt))
        ? { updatedAt: new Date(updatedAt).toISOString() }
        : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function listWithTimeout(list: () => Promise<SecretListing[]>): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      list(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('listing timed out'));
        }, LIST_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The secrets a provider instance makes available (names only), who uses each, and the
 * references to this provider whose names it does not list.
 */
export async function providerSecrets(
  ctx: ApiContext,
  id: string,
): Promise<ProviderSecretsResponse> {
  const [row] = await ctx.db
    .select({ id: secretProviders.id, name: secretProviders.name })
    .from(secretProviders)
    .where(eq(secretProviders.id, id));
  if (!row) throw notFound('Secret provider');
  const base = { providerId: row.id, provider: row.name };
  const unavailable = (error: string): ProviderSecretsResponse => ({
    ...base,
    available: false,
    error,
    secrets: [],
    missing: [],
  });

  const live = ctx.host.secretProvider(row.id);
  if (!live) {
    const why = ctx.runtime.instanceError(row.id);
    return unavailable(
      why === 'disabled'
        ? 'The provider is disabled.'
        : `The provider is not running${why ? ` (${why})` : ''}.`,
    );
  }
  const provider = live.provider;
  if (typeof provider.list !== 'function') {
    return unavailable(`The ${live.type.displayName} provider type cannot list its secrets.`);
  }

  let listing: SecretListing[];
  try {
    // The live provider is wrapped by the host, so an exception here is already attributed.
    listing = sanitize(await listWithTimeout(() => provider.list?.() ?? Promise.resolve([])));
  } catch (err) {
    return unavailable(`Listing failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const users = await usersByName(ctx, row.name);
  const ref = (name: string): string => formatSecretRef({ provider: row.name, name });
  const listed = new Set(listing.map((s) => s.name));
  const secrets: ProviderSecretDTO[] = listing.map((s) => ({
    ...s,
    ref: ref(s.name),
    usedBy: users.get(s.name) ?? [],
  }));
  const missing: MissingSecretDTO[] = [...users.entries()]
    .filter(([name]) => !listed.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, usedBy]) => ({ name, ref: ref(name), usedBy }));
  return { ...base, available: true, secrets, missing };
}
