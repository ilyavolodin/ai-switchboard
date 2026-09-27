import { type QueryKey, useQuery } from '@tanstack/react-query';

import { apiFetch, type QueryValue } from './client.js';

/**
 * Cursor paging for every paged list (`Page<T>`): spread into `useInfiniteQuery` and pass
 * `pageParam` as the `cursor` query value.
 */
export const cursorPaging = {
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
};

/** Options `useIdQuery` passes through to `useQuery` (only the ones given, so defaults hold). */
export interface IdQueryOptions {
  /** Query string values for the GET (`window`, `limit`). */
  query?: Record<string, QueryValue>;
  refetchInterval?: number;
  staleTime?: number;
  /** Extra condition on top of "the id is known". */
  enabled?: boolean;
}

/**
 * A GET for one resource under an id that may not be known yet (a route param): disabled until
 * `id` is set. `key` and `path` receive the id.
 */
export function useIdQuery<T>(
  id: string | undefined,
  key: (id: string) => QueryKey,
  path: (id: string) => string,
  { query, enabled = true, ...options }: IdQueryOptions = {},
) {
  return useQuery({
    queryKey: key(id ?? ''),
    queryFn: ({ signal }) => apiFetch<T>(path(id ?? ''), { query, signal }),
    enabled: Boolean(id) && enabled,
    ...options,
  });
}
