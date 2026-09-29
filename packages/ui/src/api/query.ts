import { type QueryKey, useQuery } from '@tanstack/react-query';

import { apiFetch, type QueryValue } from './client.js';

/** Spread into `useInfiniteQuery` and pass `pageParam` as the `cursor` query value. */
export const cursorPaging = {
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
};

export interface IdQueryOptions {
  query?: Record<string, QueryValue>;
  refetchInterval?: number;
  staleTime?: number;
  /** Extra condition on top of "the id is known". */
  enabled?: boolean;
}

/** Disabled until `id` (usually a route param) is known. */
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
