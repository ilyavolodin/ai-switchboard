import type { JSONSchema, ProviderSecretsResponse } from '@ai-switchboard/core/contract';
import { secretPaths } from '@ai-switchboard/sdk/schema';
import { queryOptions, useQueries, useQuery } from '@tanstack/react-query';

import { useCan } from '../../app/session.js';
import { instanceForProvider, secretProviderIds } from '../../lib/secretProviders.js';
import { apiFetch } from '../client.js';
import { qk } from '../keys.js';
import { instancesQuery, useInstances } from './instances.js';

const providerSecretsQuery = (id: string) =>
  queryOptions({
    queryKey: qk.providerSecrets(id),
    queryFn: ({ signal }) =>
      apiFetch('GET /secret-providers/:id/secrets', { params: { id }, signal }),
    staleTime: 30_000,
  });

export function useProviderSecrets(id: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    ...providerSecretsQuery(id ?? ''),
    enabled: Boolean(id) && (options.enabled ?? true),
  });
}

/** Secret names a provider lists, or `null` when unknown (not an admin, cannot list, loading). */
export type SecretNames = (provider: string) => string[] | null;

// Names the host stored for an instance are its own; a settings field never points at one.
function listedNames(data: ProviderSecretsResponse | undefined): string[] | null {
  return data?.available ? data.secrets.filter((s) => !s.storedBy).map((s) => s.name) : null;
}

/**
 * Only admins may list names. Pass `enabled: false` when the form has no secret field, so nothing
 * is fetched.
 */
export function useSecretNames(enabled = true): SecretNames {
  const admin = useCan('admin');
  const on = enabled && admin;
  const instances = useQuery({ ...instancesQuery('secret-providers'), enabled: on });
  const list = on ? (instances.data ?? []) : [];
  const listings = useQueries({
    queries: list.map((i) => providerSecretsQuery(i.id)),
  });
  return (provider) => {
    const i = list.findIndex((x) => x.id === instanceForProvider(provider, list)?.id);
    return i === -1 ? null : listedNames(listings[i]?.data);
  };
}

/** What `<SchemaForm>` needs for its secret fields; fetches nothing for a schema without any. */
export function useSecretFieldProps(schema: JSONSchema): {
  secretProviders: string[] | undefined;
  secretNames: SecretNames;
} {
  const providers = useInstances('secret-providers');
  const secretNames = useSecretNames(secretPaths(schema).length > 0);
  return { secretProviders: secretProviderIds(providers.data), secretNames };
}
