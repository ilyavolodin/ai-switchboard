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

export function useDestinations() {
  return useQuery({
    queryKey: qk.destinations.list(),
    queryFn: ({ signal }) => apiFetch<DestinationSummary[]>('/destinations', { signal }),
    refetchInterval: POLL.lists,
  });
}

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

export function useDestinationMeters(id: string | undefined, window: StatsWindow = '7d') {
  return useIdQuery<MeterHistoryResponse>(
    id,
    (i) => qk.destinations.meters(i, window),
    (i) => `/destinations/${seg(i)}/meters`,
    { query: { window } },
  );
}

export function useDestinationUsage(id: string | undefined, window: StatsWindow = '7d') {
  return useIdQuery<UsageHistoryResponse>(
    id,
    (i) => qk.destinations.usage(i, window),
    (i) => `/destinations/${seg(i)}/usage`,
    { query: { window } },
  );
}

export function useCreateDestination() {
  return useApiMutation<CreateDestinationRequest, DestinationDetail>({
    method: 'POST',
    path: () => '/destinations',
    invalidate: fleet,
  });
}

export function useUpdateDestination() {
  return useApiMutation<UpdateDestinationRequest & { id: string }, DestinationDetail>({
    method: 'PUT',
    path: (v) => `/destinations/${seg(v.id)}`,
    invalidate: fleet,
  });
}

export function useDeleteDestination() {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/destinations/${seg(v.id)}`,
    invalidate: fleet,
  });
}

export function useEnableDestination() {
  return useApiMutation<EnableRequest & { id: string }, DestinationDetail>({
    method: 'POST',
    path: (v) => `/destinations/${seg(v.id)}/enable`,
    invalidate: fleet,
  });
}

export function useReloadDestination() {
  return useApiMutation<Reasoned & { id: string }, DestinationDetail>({
    method: 'POST',
    path: (v) => `/destinations/${seg(v.id)}/reload`,
    invalidate: fleet,
  });
}

export function useReadMeters() {
  return useApiMutation<Reasoned & { id: string }, MeterGaugeDTO[]>({
    method: 'POST',
    path: (v) => `/destinations/${seg(v.id)}/meters/read`,
    invalidate: fleet,
  });
}

export function useClearSoftHold() {
  return useApiMutation<Reasoned & { id: string }, DestinationDetail>({
    method: 'POST',
    path: (v) => `/destinations/${seg(v.id)}/soft-hold/clear`,
    invalidate: fleet,
  });
}
