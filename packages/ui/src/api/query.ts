import { type QueryKey, useQuery } from '@tanstack/react-query';

import { apiFetch, type PathParam, type Route, type RouteQuery } from './client.js';

/** Spread into `useInfiniteQuery` and pass `pageParam` as the `cursor` query value. */
export const cursorPaging = {
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
};

/** A GET whose only path parameter is `:id`. */
export type IdRoute = {
  [R in Route]: R extends `GET ${string}` ? ([PathParam<R>] extends ['id'] ? R : never) : never;
}[Route];

export interface IdQueryOptions<R extends IdRoute> {
  query?: RouteQuery<R>;
  refetchInterval?: number;
  staleTime?: number;
  /** Extra condition on top of "the id is known". */
  enabled?: boolean;
}

/** Disabled until `id` (usually a route param) is known. */
export function useIdQuery<R extends IdRoute>(
  route: R,
  id: string | undefined,
  key: (id: string) => QueryKey,
  { query, enabled = true, ...options }: IdQueryOptions<R> = {},
) {
  return useQuery({
    queryKey: key(id ?? ''),
    queryFn: ({ signal }) =>
      (apiFetch as (r: R, o: object) => ReturnType<typeof apiFetch<R>>)(route, {
        params: { id: id ?? '' },
        query,
        signal,
      }),
    enabled: Boolean(id) && enabled,
    ...options,
  });
}
