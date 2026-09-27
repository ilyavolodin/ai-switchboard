import type { SecretListing } from '@ai-switchboard/sdk';
import { eq } from 'drizzle-orm';

import { executors, notifiers, processes, secretProviders, sources } from '../../db/schema.js';
import { collectSecretRefs, formatSecretRef, parseSecretRef } from '../../secrets/refs.js';
import type { ApiContext } from '../context.js';
import type {
  MissingSecretDTO,
  ProviderSecretDTO,
  ProviderSecretsResponse,
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
  const rows: { kind: SecretUserDTO['kind']; id: string; name: string; value: unknown }[] = [];
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
    for (const r of found) rows.push({ kind, id: r.id, name: r.name, value: r.settings });
  }
  for (const p of await db
    .select({ id: processes.id, name: processes.name, document: processes.document })
    .from(processes)) {
    rows.push({ kind: 'process', id: p.id, name: p.name, value: p.document });
  }

  const byName = new Map<string, SecretUserDTO[]>();
  for (const row of rows) {
    for (const { path, ref } of collectSecretRefs(row.value)) {
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
