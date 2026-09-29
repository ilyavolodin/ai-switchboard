import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';

import {
  apiFetch,
  type MutationRoute,
  type RouteBody,
  type RouteParams,
  type RouteRes,
  routeParamNames,
} from './client.js';

/** What `mutate` takes: the route's body plus its path parameters (`id`, `batchId`, …). */
export type MutationVars<R extends MutationRoute> = (RouteBody<R> extends undefined
  ? unknown
  : RouteBody<R>) &
  RouteParams<R>;

/** The route's `:params` are taken out of the variables; the rest is the body. */
export function useApiMutation<R extends MutationRoute>(
  route: R,
  config: {
    invalidate: QueryKey[] | ((vars: MutationVars<R>, data: RouteRes<R>) => QueryKey[]);
    onSuccess?: (data: RouteRes<R>, vars: MutationVars<R>) => void;
  },
) {
  const qc = useQueryClient();
  const names = routeParamNames(route);
  return useMutation<RouteRes<R>, Error, MutationVars<R>>({
    mutationFn: (vars) => {
      const params: Record<string, string | number> = {};
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
        if (names.includes(k)) params[k] = v as string | number;
        else body[k] = v;
      }
      return (apiFetch as (r: R, o: object) => Promise<RouteRes<R>>)(route, { params, body });
    },
    onSuccess: async (data, vars) => {
      config.onSuccess?.(data, vars);
      const keys =
        typeof config.invalidate === 'function' ? config.invalidate(vars, data) : config.invalidate;
      await Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
    },
  });
}
