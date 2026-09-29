import { queryOptions, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { qk } from '../keys.js';
import { useApiMutation } from '../mutation.js';

export type InstanceRoute = 'notifiers' | 'secret-providers';

export const instancesQuery = (route: InstanceRoute) =>
  queryOptions({
    queryKey: qk.instances(route),
    queryFn: ({ signal }) => apiFetch(`GET /${route}`, { signal }),
  });

export function useInstances(route: InstanceRoute) {
  return useQuery(instancesQuery(route));
}

export const useNotifiers = () => useInstances('notifiers');
export const useSecretProviders = () => useInstances('secret-providers');

/**
 * A secret-provider change rebuilds the sources, destinations and notifiers that reference it, so
 * their lists (and the board) refresh too.
 */
function refreshed(route: InstanceRoute) {
  return route === 'secret-providers'
    ? [
        qk.instances(route),
        qk.instances('notifiers'),
        qk.sources.all,
        qk.destinations.all,
        qk.board,
      ]
    : [qk.instances(route)];
}

export function useCreateInstance(route: InstanceRoute) {
  return useApiMutation(`POST /${route}`, { invalidate: refreshed(route) });
}

export function useUpdateInstance(route: InstanceRoute) {
  return useApiMutation(`PUT /${route}/:id`, { invalidate: refreshed(route) });
}

export function useEnableInstance(route: InstanceRoute) {
  return useApiMutation(`POST /${route}/:id/enable`, { invalidate: refreshed(route) });
}

export function useReloadInstance(route: InstanceRoute) {
  return useApiMutation(`POST /${route}/:id/reload`, { invalidate: refreshed(route) });
}

export function useDeleteInstance(route: InstanceRoute) {
  return useApiMutation(`DELETE /${route}/:id`, { invalidate: refreshed(route) });
}

export function useTestNotifier() {
  return useApiMutation('POST /notifiers/:id/test', { invalidate: [qk.instances('notifiers')] });
}
