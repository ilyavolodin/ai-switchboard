import type { InstanceSummary, ProviderSecretsResponse } from '@ai-switchboard/core/contract';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { useContext } from 'react';

import { useCan } from '../../app/session.js';
import { apiFetch } from '../client.js';
import { qk } from '../keys.js';
import { seg } from '../mutation.js';

/**
 * Under the secret-providers key, so saving, reloading or deleting a provider (which invalidates
 * `qk.instances('secret-providers')`) refreshes its listing too.
 */
const secretsKey = (id: string) => [...qk.instances('secret-providers'), 'secrets', id] as const;

/** GET /secret-providers/:id/secrets — names only, never values (admin). */
export function useProviderSecrets(id: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: secretsKey(id ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<ProviderSecretsResponse>(`/secret-providers/${seg(id ?? '')}/secrets`, { signal }),
    enabled: id != null && (options.enabled ?? true),
    staleTime: 30_000,
  });
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** The instance a `secret://<provider>/…` segment names (by name, or by type for odd names). */
function instanceFor(
  provider: string,
  instances: InstanceSummary[] | undefined,
): InstanceSummary | undefined {
  return (
    instances?.find((i) => i.name === provider) ??
    instances?.find((i) => !SEGMENT.test(i.name) && i.typeId === provider)
  );
}

/** Never fetches: stands in when a component renders outside a QueryClientProvider. */
const inertClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });

/** What `SecretRefInput` knows about the names a provider lists. */
export interface SecretSuggestions {
  /** Listed names, or `null` when unknown (not an admin, cannot list, still loading). */
  names: string[] | null;
}

/**
 * The secret names a provider lists, for suggestions in a secret-reference input. Only admins may
 * list names, so for everyone else (and outside a query client) it quietly returns `null`.
 */
export function useSecretSuggestions(provider: string): SecretSuggestions {
  const client = useContext(QueryClientContext);
  const admin = useCan('admin');
  const enabled = client != null && admin;
  const instances = useQuery(
    {
      queryKey: qk.instances('secret-providers'),
      queryFn: ({ signal }) => apiFetch<InstanceSummary[]>('/secret-providers', { signal }),
      enabled,
    },
    client ?? inertClient,
  );
  const id = instanceFor(provider, instances.data)?.id;
  const listing = useQuery(
    {
      queryKey: secretsKey(id ?? ''),
      queryFn: ({ signal }) =>
        apiFetch<ProviderSecretsResponse>(`/secret-providers/${seg(id ?? '')}/secrets`, {
          signal,
        }),
      enabled: enabled && id != null,
      staleTime: 30_000,
    },
    client ?? inertClient,
  );
  const data = listing.data;
  return { names: data?.available ? data.secrets.map((s) => s.name) : null };
}
