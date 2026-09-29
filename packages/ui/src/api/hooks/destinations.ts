import type { StatsWindow } from '@ai-switchboard/core/contract';
import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { useApiMutation } from '../mutation.js';
import { useIdQuery } from '../query.js';

const fleet = [qk.destinations.all, qk.board, qk.status, qk.processes.all];

export function useDestinations() {
  return useQuery({
    queryKey: qk.destinations.list(),
    queryFn: ({ signal }) => apiFetch('GET /destinations', { signal }),
    refetchInterval: POLL.lists,
  });
}

export function useDestination(id: string | undefined) {
  return useIdQuery('GET /destinations/:id', id, qk.destinations.detail, {
    refetchInterval: POLL.lists,
  });
}

export function useDestinationMeters(id: string | undefined, window: StatsWindow = '7d') {
  return useIdQuery('GET /destinations/:id/meters', id, (i) => qk.destinations.meters(i, window), {
    query: { window },
  });
}

export function useDestinationUsage(id: string | undefined, window: StatsWindow = '7d') {
  return useIdQuery('GET /destinations/:id/usage', id, (i) => qk.destinations.usage(i, window), {
    query: { window },
  });
}

export function useCreateDestination() {
  return useApiMutation('POST /destinations', { invalidate: fleet });
}

export function useUpdateDestination() {
  return useApiMutation('PUT /destinations/:id', { invalidate: fleet });
}

export function useDeleteDestination() {
  return useApiMutation('DELETE /destinations/:id', { invalidate: fleet });
}

export function useEnableDestination() {
  return useApiMutation('POST /destinations/:id/enable', { invalidate: fleet });
}

export function useReloadDestination() {
  return useApiMutation('POST /destinations/:id/reload', { invalidate: fleet });
}

export function useReadMeters() {
  return useApiMutation('POST /destinations/:id/meters/read', { invalidate: fleet });
}

export function useClearSoftHold() {
  return useApiMutation('POST /destinations/:id/soft-hold/clear', { invalidate: fleet });
}
