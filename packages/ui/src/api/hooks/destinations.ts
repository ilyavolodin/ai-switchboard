import type {
  CreateDestinationRequest,
  EnableRequest,
  DestinationDetail,
  DestinationSummary,
  MeterGaugeDTO,
  MeterHistoryResponse,
  Reasoned,
  StatsWindow,
  UpdateDestinationRequest,
  UsageHistoryResponse,
} from '@ai-switchboard/core/contract';
import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { seg, useApiMutation } from '../mutation.js';
import { useIdQuery } from '../query.js';

const fleet = [qk.destinations.all, qk.board, qk.status, qk.processes.all];

/** GET /destinations */
export function useDestinations() {
  return useQuery({
    queryKey: qk.destinations.list(),
    queryFn: ({ signal }) => apiFetch<DestinationSummary[]>('/destinations', { signal }),
    refetchInterval: POLL.lists,
  });
}

/** GET /destinations/:id */
export function useDestination(id: string | undefined) {
  return useIdQuery<DestinationDetail>(
    id,
    qk.destinations.detail,
    (i) => `/destinations/${seg(i)}`,
    {
      refetchInterval: POLL.lists,
    },
  );
}

/** GET /destinations/:id/meters?window= — meter history with run markers. */
export function useDestinationMeters(id: string | undefined, window: StatsWindow = '7d') {
  return useIdQuery<MeterHistoryResponse>(
    id,
    (i) => qk.destinations.meters(i, window),
    (i) => `/destinations/${seg(i)}/meters`,
    { query: { window } },
  );
}

/** GET /destinations/:id/usage?window= — usage per day per dimension, runs by status. */
export function useDestinationUsage(id: string | undefined, window: StatsWindow = '7d') {
  return useIdQuery<UsageHistoryResponse>(
    id,
    (i) => qk.destinations.usage(i, window),
    (i) => `/destinations/${seg(i)}/usage`,
    { query: { window } },
  );
}

/** POST /destinations */
export function useCreateDestination() {
  return useApiMutation<CreateDestinationRequest, DestinationDetail>({
    method: 'POST',
    path: () => '/destinations',
    invalidate: fleet,
  });
}

/** PUT /destinations/:id */
export function useUpdateDestination() {
  return useApiMutation<UpdateDestinationRequest & { id: string }, DestinationDetail>({
    method: 'PUT',
    path: (v) => `/destinations/${seg(v.id)}`,
    invalidate: fleet,
  });
}

/** DELETE /destinations/:id */
export function useDeleteDestination() {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/destinations/${seg(v.id)}`,
    invalidate: fleet,
  });
}

/** POST /destinations/:id/enable */
export function useEnableDestination() {
  return useApiMutation<EnableRequest & { id: string }, DestinationDetail>({
    method: 'POST',
    path: (v) => `/destinations/${seg(v.id)}/enable`,
    invalidate: fleet,
  });
}

/** POST /destinations/:id/reload */
export function useReloadDestination() {
  return useApiMutation<Reasoned & { id: string }, DestinationDetail>({
    method: 'POST',
    path: (v) => `/destinations/${seg(v.id)}/reload`,
    invalidate: fleet,
  });
}

/** POST /destinations/:id/meters/read — read meters now. */
export function useReadMeters() {
  return useApiMutation<Reasoned & { id: string }, MeterGaugeDTO[]>({
    method: 'POST',
    path: (v) => `/destinations/${seg(v.id)}/meters/read`,
    invalidate: fleet,
  });
}

/** POST /destinations/:id/soft-hold/clear */
export function useClearSoftHold() {
  return useApiMutation<Reasoned & { id: string }, DestinationDetail>({
    method: 'POST',
    path: (v) => `/destinations/${seg(v.id)}/soft-hold/clear`,
    invalidate: fleet,
  });
}
