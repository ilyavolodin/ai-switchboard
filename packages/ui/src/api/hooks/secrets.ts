import type { ProviderSecretsResponse } from '@ai-switchboard/core/contract';
import { QueryClient, QueryClientContext, queryOptions, useQuery } from '@tanstack/react-query';
import { useContext } from 'react';

import { useCan } from '../../app/session.js';
import { instanceForProvider } from '../../lib/instances.js';
import { apiFetch } from '../client.js';
import { qk } from '../keys.js';
import { seg } from '../mutation.js';
import { instancesQuery } from './instances.js';

/** The query for GET /secret-providers/:id/secrets (shared with `useSecretSuggestions`). */
const providerSecretsQuery = (id: string) =>
  queryOptions({
    queryKey: qk.providerSecrets(id),
    queryFn: ({ signal }) =>
      apiFetch<ProviderSecretsResponse>(`/secret-providers/${seg(id)}/secrets`, { signal }),
    staleTime: 30_000,
  });

/** GET /secret-providers/:id/secrets — names only, never values (admin). */
export function useProviderSecrets(id: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    ...providerSecretsQuery(id ?? ''),
    enabled: Boolean(id) && (options.enabled ?? true),
  });
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
    { ...instancesQuery('secret-providers'), enabled },
    client ?? inertClient,
  );
  const id = instanceForProvider(provider, instances.data)?.id;
  const listing = useQuery(
    { ...providerSecretsQuery(id ?? ''), enabled: enabled && id != null },
    client ?? inertClient,
  );
  const data = listing.data;
  return { names: data?.available ? data.secrets.map((s) => s.name) : null };
}
