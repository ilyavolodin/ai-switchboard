import { QueryCache, QueryClient } from '@tanstack/react-query';

import { isApiRequestError } from '../api/client.js';
import { qk } from '../api/keys.js';

/**
 * The app's QueryClient. Client errors (4xx) are not retried; a 401 from any query re-checks
 * `/auth/me` so the shell can send the person to sign in.
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (isApiRequestError(error) && error.status === 401 && query.queryKey[0] !== qk.me[0]) {
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
