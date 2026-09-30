import type { SecretListing } from '@ai-switchboard/sdk';

import type {
  MissingSecretDTO,
  ProviderSecretDTO,
  ProviderSecretsResponse,
  SecretOwnerDTO,
  SecretProviderDependentDTO,
} from '../contract/index.js';
import type { DbOrTx } from '../db/client.js';
import { secretProviders } from '../db/schema.js';
import { formatInstanceError, instanceErrorText } from '../domain/instance-error.js';
import { instanceStatus } from '../domain/labels.js';
import type { PluginAdminPort } from '../plugins/admin-port.js';
import { instanceSecretPrefix } from '../plugins/instance-secrets.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import { formatSecretRef } from '../secrets/refs.js';
import { errorText } from '../util/errors.js';
import { withTimeout } from '../util/timeout.js';
import { requireById } from './lookup.js';
import {
  holdersByProvider,
  secretRefIndex,
  usersByName,
  type SecretHolder,
} from './secret-users.js';

/** How long a provider's `list()` may take before the listing is reported unavailable. */
const LIST_TIMEOUT_MS = 10_000;

const HOST_NAME_START = instanceSecretPrefix('').slice(0, -1);

export interface SecretProviderDeps {
  db: DbOrTx;
  runtime: PluginRuntime;
  host: Pick<PluginAdminPort, 'secretProvider'>;
}

function isRunnable(
  h: SecretHolder,
): h is SecretHolder & { kind: SecretProviderDependentDTO['kind'] } {
  return h.kind === 'source' || h.kind === 'destination' || h.kind === 'notifier';
}

/**
 * The sources, destinations and notifiers whose settings reference each provider name, with the
 * status they have now (so right after a rebuild, the result of it).
 */
export async function providerDependents(
  deps: Pick<SecretProviderDeps, 'db' | 'runtime'>,
  providerNames: readonly string[],
): Promise<Map<string, SecretProviderDependentDTO[]>> {
  if (providerNames.length === 0) return new Map();
  const byProvider = holdersByProvider(await secretRefIndex(deps.db), providerNames);
  const out = new Map<string, SecretProviderDependentDTO[]>();
  for (const [provider, holders] of byProvider) {
    out.set(
      provider,
      holders.filter(isRunnable).map((h) => {
        const error = deps.runtime.instanceError(h.id);
        return {
          kind: h.kind,
          id: h.id,
          name: h.name,
          status: instanceStatus({ enabled: h.enabled, health: h.health, instanceError: error }),
          instanceError: instanceErrorText(error),
        };
      }),
    );
  }
  return out;
}

/**
 * Keep only the fields the contract allows, so a provider that returns more (a value, by
 * mistake) cannot push it through the API. Entries without a usable name are dropped.
 */
export function sanitizeListing(listing: unknown): SecretListing[] {
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

/**
 * The secrets a provider instance makes available (names only), who uses each, and the
 * references to this provider whose names it does not list.
 */
export async function providerSecrets(
  deps: SecretProviderDeps,
  id: string,
): Promise<ProviderSecretsResponse> {
  const row = await requireById(deps.db, secretProviders, id, 'Secret provider');
  const base = { providerId: row.id, provider: row.name };
  const unavailable = (error: string): ProviderSecretsResponse => ({
    ...base,
    available: false,
    error,
    secrets: [],
    missing: [],
  });

  const live = deps.host.secretProvider(row.id);
  if (!live) {
    const why = deps.runtime.instanceError(row.id);
    return unavailable(
      why?.code === 'disabled'
        ? 'The provider is disabled.'
        : `The provider is not running${why ? ` (${formatInstanceError(why)})` : ''}.`,
    );
  }
  const provider = live.provider;
  if (typeof provider.list !== 'function') {
    return unavailable(`The ${live.type.displayName} provider type cannot list its secrets.`);
  }

  let listing: SecretListing[];
  try {
    // The live provider is wrapped by the host, so an exception here is already attributed.
    listing = sanitizeListing(
      await withTimeout<unknown>(provider.list(), LIST_TIMEOUT_MS, 'listing timed out'),
    );
  } catch (err) {
    return unavailable(`Listing failed: ${errorText(err)}`);
  }

  const index = await secretRefIndex(deps.db);
  const users = usersByName(index, row.name);
  const ref = (name: string): string => formatSecretRef({ provider: row.name, name });
  const listed = new Set(listing.map((s) => s.name));
  const owners: SecretOwnerDTO[] = index.flatMap((h) =>
    h.kind === 'process' ? [] : [{ kind: h.kind, id: h.id, name: h.name }],
  );
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
