import type {
  CreateExecutorRequest,
  EnableRequest,
  ExecutorDetail,
  ExecutorSummary,
  MeterGaugeDTO,
  MeterHistoryResponse,
  Reasoned,
  StatsWindow,
  UpdateExecutorRequest,
  UsageHistoryResponse,
} from '@ai-switchboard/core/contract';
import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { seg, useApiMutation } from '../mutation.js';
import { useIdQuery } from '../query.js';

const fleet = [qk.executors.all, qk.board, qk.status, qk.processes.all];

/** GET /executors */
export function useExecutors() {
  return useQuery({
    queryKey: qk.executors.list(),
    queryFn: ({ signal }) => apiFetch<ExecutorSummary[]>('/executors', { signal }),
    refetchInterval: POLL.lists,
  });
}

/** GET /executors/:id */
export function useExecutor(id: string | undefined) {
  return useIdQuery<ExecutorDetail>(id, qk.executors.detail, (i) => `/executors/${seg(i)}`, {
    refetchInterval: POLL.lists,
  });
}

/** GET /executors/:id/meters?window= — meter history with run markers. */
export function useExecutorMeters(id: string | undefined, window: StatsWindow = '7d') {
  return useIdQuery<MeterHistoryResponse>(
    id,
    (i) => qk.executors.meters(i, window),
    (i) => `/executors/${seg(i)}/meters`,
    { query: { window } },
  );
}

/** GET /executors/:id/usage?window= — usage per day per dimension, runs by status. */
export function useExecutorUsage(id: string | undefined, window: StatsWindow = '7d') {
  return useIdQuery<UsageHistoryResponse>(
    id,
    (i) => qk.executors.usage(i, window),
    (i) => `/executors/${seg(i)}/usage`,
    { query: { window } },
  );
}

/** POST /executors */
export function useCreateExecutor() {
  return useApiMutation<CreateExecutorRequest, ExecutorDetail>({
    method: 'POST',
    path: () => '/executors',
    invalidate: fleet,
  });
}

/** PUT /executors/:id */
export function useUpdateExecutor() {
  return useApiMutation<UpdateExecutorRequest & { id: string }, ExecutorDetail>({
    method: 'PUT',
    path: (v) => `/executors/${seg(v.id)}`,
    invalidate: fleet,
  });
}

/** DELETE /executors/:id */
export function useDeleteExecutor() {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/executors/${seg(v.id)}`,
    invalidate: fleet,
  });
}

/** POST /executors/:id/enable */
export function useEnableExecutor() {
  return useApiMutation<EnableRequest & { id: string }, ExecutorDetail>({
    method: 'POST',
    path: (v) => `/executors/${seg(v.id)}/enable`,
    invalidate: fleet,
  });
}

/** POST /executors/:id/reload */
export function useReloadExecutor() {
  return useApiMutation<Reasoned & { id: string }, ExecutorDetail>({
    method: 'POST',
    path: (v) => `/executors/${seg(v.id)}/reload`,
    invalidate: fleet,
  });
}

/** POST /executors/:id/meters/read — read meters now. */
export function useReadMeters() {
  return useApiMutation<Reasoned & { id: string }, MeterGaugeDTO[]>({
    method: 'POST',
    path: (v) => `/executors/${seg(v.id)}/meters/read`,
    invalidate: fleet,
  });
}

/** POST /executors/:id/soft-hold/clear */
export function useClearSoftHold() {
  return useApiMutation<Reasoned & { id: string }, ExecutorDetail>({
    method: 'POST',
    path: (v) => `/executors/${seg(v.id)}/soft-hold/clear`,
    invalidate: fleet,
  });
}
