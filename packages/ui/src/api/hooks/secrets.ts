import { QueryClient, QueryClientContext, queryOptions, useQuery } from '@tanstack/react-query';
import { useContext } from 'react';

import { useCan } from '../../app/session.js';
import { instanceForProvider } from '../../lib/instances.js';
import { apiFetch } from '../client.js';
import { qk } from '../keys.js';
import { instancesQuery } from './instances.js';

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

/** Never fetches: stands in when a component renders outside a QueryClientProvider. */
const inertClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });

export interface SecretSuggestions {
  /** `null` when unknown (not an admin, cannot list, still loading). */
  names: string[] | null;
}

/** Only admins may list names, so for everyone else (and outside a query client) it's `null`. */
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
  // Names the host stored for an instance are its own; a settings field never points at one.
  return {
    names: data?.available ? data.secrets.filter((s) => !s.storedBy).map((s) => s.name) : null,
  };
}
