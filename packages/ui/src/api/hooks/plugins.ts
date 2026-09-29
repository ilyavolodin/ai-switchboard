import type { InspectPluginRequest, PluginSearchKind } from '@ai-switchboard/core/contract';
import { useMutation, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { useApiMutation } from '../mutation.js';

export function usePlugins() {
  return useQuery({
    queryKey: qk.plugins.installed(),
    queryFn: ({ signal }) => apiFetch('GET /plugins', { signal }),
    refetchInterval: POLL.lists,
  });
}

/** A 503 means the registry is unreachable (offline installs). */
export function usePluginSearch(kind: PluginSearchKind | undefined, q: string, enabled = true) {
  return useQuery({
    queryKey: qk.plugins.search(kind ?? 'all', q),
    queryFn: ({ signal }) => apiFetch('GET /plugins/search', { signal, query: { kind, q } }),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useInspectPlugin() {
  return useMutation({
    mutationFn: (body: InspectPluginRequest) => apiFetch('POST /plugins/inspect', { body }),
  });
}

/** `pendingRestart` is set when another version of the plugin is already loaded. */
export function useInstallPlugin() {
  return useApiMutation('POST /plugins', { invalidate: [qk.plugins.all, qk.pluginTypesAll] });
}

/** Applies on restart. */
export function useRemovePlugin() {
  return useApiMutation('DELETE /plugins/:name', { invalidate: [qk.plugins.all] });
}
