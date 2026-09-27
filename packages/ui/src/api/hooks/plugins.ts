import type {
  CatalogueEntry,
  InspectPluginRequest,
  InspectPluginResponse,
  InstallPluginRequest,
  PluginSummary,
  Reasoned,
} from '@ai-switchboard/core/contract';
import { useMutation, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { seg, useApiMutation } from '../mutation.js';

/** GET /plugins — installed plugins with health. */
export function usePlugins() {
  return useQuery({
    queryKey: qk.plugins.installed(),
    queryFn: ({ signal }) => apiFetch<PluginSummary[]>('/plugins', { signal }),
    refetchInterval: POLL.lists,
  });
}

/** GET /plugins/catalogue — the project's reviewed plugins. */
export function useCatalogue() {
  return useQuery({
    queryKey: qk.plugins.catalogue(),
    queryFn: ({ signal }) => apiFetch<CatalogueEntry[]>('/plugins/catalogue', { signal }),
    staleTime: 10 * 60_000,
  });
}

/** POST /plugins/inspect — read a package's manifest before installing (no side effect). */
export function useInspectPlugin() {
  return useMutation<InspectPluginResponse, Error, InspectPluginRequest>({
    mutationFn: (body) =>
      apiFetch<InspectPluginResponse>('/plugins/inspect', { method: 'POST', body }),
  });
}

/** POST /plugins — install; applies on restart. */
export function useInstallPlugin() {
  return useApiMutation<InstallPluginRequest, PluginSummary>({
    method: 'POST',
    path: () => '/plugins',
    invalidate: [qk.plugins.all],
  });
}

/** DELETE /plugins/:name — remove; applies on restart. */
export function useRemovePlugin() {
  return useApiMutation<Reasoned & { pluginName: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/plugins/${seg(v.pluginName)}`,
    invalidate: [qk.plugins.all],
  });
}
