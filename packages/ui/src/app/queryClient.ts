import { QueryCache, QueryClient } from '@tanstack/react-query';

import { isApiRequestError } from '../api/client.js';
import { qk } from '../api/keys.js';

/** A 401, or the 403 a session with a temporary password gets: the shell re-checks `/auth/me`. */
function needsSessionCheck(error: unknown): boolean {
  if (!isApiRequestError(error)) return false;
  return (
    error.status === 401 ||
    (error.status === 403 && error.body.error === 'password_change_required')
  );
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (needsSessionCheck(error) && query.queryKey[0] !== qk.me[0]) {
          void client.invalidateQueries({ queryKey: qk.me });
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: (count, error) => {
          if (isApiRequestError(error) && error.status >= 400 && error.status < 500) return false;
          return count < 2;
        },
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
  return client;
}
