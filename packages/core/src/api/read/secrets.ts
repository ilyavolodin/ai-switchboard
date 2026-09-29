import type { SecretListing } from '@ai-switchboard/sdk';
import { eq } from 'drizzle-orm';

import { INSTANCE_TABLES } from '../../db/instance-tables.js';
import { secretProviders } from '../../db/schema.js';
import { instanceStatus } from '../../domain/labels.js';
import { instanceSecretPrefix } from '../../plugins/instance-secrets.js';
import { collectSecretRefs, formatSecretRef, parseSecretRef } from '../../secrets/refs.js';
import { secretUsersByName } from '../../services/secret-users.js';
import { errorText } from '../../util/errors.js';
import { withTimeout } from '../../util/timeout.js';
import type { ApiContext } from '../context.js';
import type {
  MissingSecretDTO,
  ProviderSecretDTO,
  ProviderSecretsResponse,
  SecretOwnerDTO,
  SecretProviderDependentDTO,
} from '../contract.js';
import { notFound } from '../errors.js';

/** How long a provider's `list()` may take before the listing is reported unavailable. */
const LIST_TIMEOUT_MS = 10_000;

/**
 * The sources, destinations and notifiers whose settings reference each provider name, with the
 * status they have now (so right after a rebuild, the result of it).
 */
export async function providerDependents(
  ctx: ApiContext,
  providerNames: readonly string[],
): Promise<Map<string, SecretProviderDependentDTO[]>> {
  const out = new Map<string, SecretProviderDependentDTO[]>(providerNames.map((n) => [n, []]));
  if (providerNames.length === 0) return out;
  for (const kind of ['source', 'destination', 'notifier'] as const) {
    const table = INSTANCE_TABLES[kind];
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

const HOST_NAME_START = instanceSecretPrefix('').slice(0, -1);

/** The instance whose rotated credential this name holds; the longest id prefix wins. */
export function storedByOf(
  name: string,
  owners: readonly SecretOwnerDTO[],
): SecretOwnerDTO | undefined {
  if (!name.startsWith(HOST_NAME_START)) return undefined;
  let best: SecretOwnerDTO | undefined;
  for (const owner of owners) {
    const prefix = instanceSecretPrefix(owner.id);
    if (name.length > prefix.length && name.startsWith(prefix)) {
      if (!best || owner.id.length > best.id.length) best = owner;
    }
  }
  return best;
}

async function instanceOwners(ctx: ApiContext): Promise<SecretOwnerDTO[]> {
  const out: SecretOwnerDTO[] = [];
  for (const kind of ['source', 'destination', 'notifier', 'secret_provider'] as const) {
    const table = INSTANCE_TABLES[kind];
    const rows = await ctx.db.select({ id: table.id, name: table.name }).from(table);
    for (const row of rows) out.push({ kind, ...row });
  }
  return out;
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
    listing = sanitize(
      await withTimeout<unknown>(provider.list(), LIST_TIMEOUT_MS, 'listing timed out'),
    );
  } catch (err) {
    return unavailable(`Listing failed: ${errorText(err)}`);
  }

  const users = await secretUsersByName(ctx.db, row.name);
  const ref = (name: string): string => formatSecretRef({ provider: row.name, name });
  const listed = new Set(listing.map((s) => s.name));
  const owners = listing.some((s) => s.name.startsWith(HOST_NAME_START))
    ? await instanceOwners(ctx)
    : [];
  const secrets: ProviderSecretDTO[] = listing.map((s) => {
    const storedBy = storedByOf(s.name, owners);
    return {
      ...s,
      ref: ref(s.name),
      usedBy: users.get(s.name) ?? [],
      ...(storedBy ? { storedBy } : {}),
    };
  });
  const missing: MissingSecretDTO[] = [...users.entries()]
    .filter(([name]) => !listed.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, usedBy]) => ({ name, ref: ref(name), usedBy }));
  return { ...base, available: true, secrets, missing };
}
