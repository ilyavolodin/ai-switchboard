import type {
  CatalogueEntry,
  InspectPluginRequest,
  InspectPluginResponse,
  InstallPluginRequest,
  PluginSearchKind,
  PluginSearchResponse,
  PluginSummary,
  Reasoned,
} from '@ai-switchboard/core/contract';
import { useMutation, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { seg, useApiMutation } from '../mutation.js';

export function usePlugins() {
  return useQuery({
    queryKey: qk.plugins.installed(),
    queryFn: ({ signal }) => apiFetch<PluginSummary[]>('/plugins', { signal }),
    refetchInterval: POLL.lists,
  });
}

export function useCatalogue() {
  return useQuery({
    queryKey: qk.plugins.catalogue(),
    queryFn: ({ signal }) => apiFetch<CatalogueEntry[]>('/plugins/catalogue', { signal }),
    staleTime: 10 * 60_000,
  });
}

/** A 503 means the registry is unreachable (offline installs). */
export function usePluginSearch(kind: PluginSearchKind | undefined, q: string, enabled = true) {
  return useQuery({
    queryKey: qk.plugins.search(kind ?? 'all', q),
    queryFn: ({ signal }) =>
      apiFetch<PluginSearchResponse>('/plugins/search', { signal, query: { kind, q } }),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useInspectPlugin() {
  return useMutation<InspectPluginResponse, Error, InspectPluginRequest>({
    mutationFn: (body) =>
      apiFetch<InspectPluginResponse>('/plugins/inspect', { method: 'POST', body }),
  });
}

/** `pendingRestart` is set when another version of the plugin is already loaded. */
export function useInstallPlugin() {
  return useApiMutation<InstallPluginRequest, PluginSummary>({
    method: 'POST',
    path: () => '/plugins',
    invalidate: [qk.plugins.all, qk.pluginTypesAll],
  });
}

/** Applies on restart. */
export function useRemovePlugin() {
  return useApiMutation<Reasoned & { pluginName: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/plugins/${seg(v.pluginName)}`,
    invalidate: [qk.plugins.all],
  });
}
