import type {
  CreateInstanceRequest,
  EnableRequest,
  InstanceSummary,
  Reasoned,
  UpdateInstanceRequest,
} from '@ai-switchboard/core/contract';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { qk } from '../keys.js';
import { seg, useApiMutation } from '../mutation.js';

/** The two routes that share the instance shape. */
export type InstanceRoute = 'notifiers' | 'secret-providers';

/** The query for GET /notifiers or /secret-providers (shared with `useSecretSuggestions`). */
export const instancesQuery = (route: InstanceRoute) =>
  queryOptions({
    queryKey: qk.instances(route),
    queryFn: ({ signal }) => apiFetch<InstanceSummary[]>(`/${route}`, { signal }),
  });

/** GET /notifiers or /secret-providers */
export function useInstances(route: InstanceRoute) {
  return useQuery(instancesQuery(route));
}

/** GET /notifiers */
export const useNotifiers = () => useInstances('notifiers');
/** GET /secret-providers */
export const useSecretProviders = () => useInstances('secret-providers');

/** POST /notifiers | /secret-providers */
export function useCreateInstance(route: InstanceRoute) {
  return useApiMutation<CreateInstanceRequest, InstanceSummary>({
    method: 'POST',
    path: () => `/${route}`,
    invalidate: [qk.instances(route)],
  });
}

/** PUT /notifiers/:id | /secret-providers/:id */
export function useUpdateInstance(route: InstanceRoute) {
  return useApiMutation<UpdateInstanceRequest & { id: string }, InstanceSummary>({
    method: 'PUT',
    path: (v) => `/${route}/${seg(v.id)}`,
    invalidate: [qk.instances(route)],
  });
}

/** POST /:route/:id/enable */
export function useEnableInstance(route: InstanceRoute) {
  return useApiMutation<EnableRequest & { id: string }, InstanceSummary>({
    method: 'POST',
    path: (v) => `/${route}/${seg(v.id)}/enable`,
    invalidate: [qk.instances(route)],
  });
}

/** POST /:route/:id/reload */
export function useReloadInstance(route: InstanceRoute) {
  return useApiMutation<Reasoned & { id: string }, InstanceSummary>({
    method: 'POST',
    path: (v) => `/${route}/${seg(v.id)}/reload`,
    invalidate: [qk.instances(route)],
  });
}

/** DELETE /:route/:id */
export function useDeleteInstance(route: InstanceRoute) {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/${route}/${seg(v.id)}`,
    invalidate: [qk.instances(route)],
  });
}

/** POST /notifiers/:id/test — send a test notification. */
export function useTestNotifier() {
  return useApiMutation<Reasoned & { id: string }, unknown>({
    method: 'POST',
    path: (v) => `/notifiers/${seg(v.id)}/test`,
    invalidate: [qk.instances('notifiers')],
  });
}
