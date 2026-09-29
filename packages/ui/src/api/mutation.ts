import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from './client.js';

/** `body` defaults to the variables minus the path params. */
export function useApiMutation<TVars, TData>(config: {
  method: 'POST' | 'PUT' | 'DELETE';
  path: (vars: TVars) => string;
  body?: (vars: TVars) => unknown;
  invalidate: QueryKey[] | ((vars: TVars, data: TData) => QueryKey[]);
  onSuccess?: (data: TData, vars: TVars) => void;
}) {
  const qc = useQueryClient();
  return useMutation<TData, Error, TVars>({
    mutationFn: (vars) =>
      apiFetch<TData>(config.path(vars), {
        method: config.method,
        body: config.body ? config.body(vars) : stripPathParams(vars),
      }),
    onSuccess: async (data, vars) => {
      config.onSuccess?.(data, vars);
      const keys =
        typeof config.invalidate === 'function' ? config.invalidate(vars, data) : config.invalidate;
      await Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
    },
  });
}

const PATH_PARAMS = new Set(['id', 'batchId', 'version', 'pluginName']);

export function stripPathParams(vars: unknown): unknown {
  if (typeof vars !== 'object' || vars === null) return vars;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) if (!PATH_PARAMS.has(k)) out[k] = v;
  return out;
}

export const seg = (s: string | number): string => encodeURIComponent(String(s));
