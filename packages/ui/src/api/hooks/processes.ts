import type {
  ActivityRow,
  BatchOutcome,
  CreateProcessRequest,
  CronPreviewRequest,
  CronPreviewResponse,
  EnableRequest,
  FilterPreviewRequest,
  FilterPreviewResponse,
  FunnelResponse,
  InputPreviewRequest,
  InputPreviewResponse,
  Page,
  ProcessDetail,
  ProcessStatsResponse,
  ProcessSummary,
  ProcessVersionDetail,
  ProcessVersionSummary,
  Reasoned,
  RecentBatchDTO,
  RunNowRequest,
  StatsWindow,
  UpdateProcessRequest,
} from '@ai-switchboard/core/contract';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { seg, useApiMutation } from '../mutation.js';
import { cursorPaging, useIdQuery } from '../query.js';

const fleet = [qk.processes.all, qk.board, qk.status, qk.approvals.all];

export function useProcesses() {
  return useQuery({
    queryKey: qk.processes.list(),
    queryFn: ({ signal }) => apiFetch<ProcessSummary[]>('/processes', { signal }),
    refetchInterval: POLL.lists,
  });
}

export function useProcess(id: string | undefined) {
  return useIdQuery<ProcessDetail>(id, qk.processes.detail, (i) => `/processes/${seg(i)}`, {
    refetchInterval: POLL.lists,
  });
}

export function useProcessFunnel(id: string | undefined, window: StatsWindow = '7d') {
  return useIdQuery<FunnelResponse>(
    id,
    (i) => qk.processes.funnel(i, window),
    (i) => `/processes/${seg(i)}/funnel`,
    { query: { window } },
  );
}

export function useProcessStats(id: string | undefined, window: StatsWindow = '7d') {
  return useIdQuery<ProcessStatsResponse>(
    id,
    (i) => qk.processes.stats(i, window),
    (i) => `/processes/${seg(i)}/stats`,
    { query: { window } },
  );
}

export function useProcessVersions(id: string | undefined) {
  return useIdQuery<ProcessVersionSummary[]>(
    id,
    qk.processes.versions,
    (i) => `/processes/${seg(i)}/versions`,
  );
}

export function useProcessVersion(id: string | undefined, version: number | undefined) {
  return useQuery({
    queryKey: qk.processes.version(id ?? '', version ?? 0),
    queryFn: ({ signal }) =>
      apiFetch<ProcessVersionDetail>(`/processes/${seg(id ?? '')}/versions/${seg(version ?? 0)}`, {
        signal,
      }),
    enabled: Boolean(id) && version != null,
  });
}

export function useProcessBatches(id: string | undefined, limit = 20) {
  return useIdQuery<RecentBatchDTO[]>(
    id,
    (i) => qk.processes.batches(i, limit),
    (i) => `/processes/${seg(i)}/batches`,
    { query: { limit } },
  );
}

export function useProcessActivity(id: string | undefined) {
  return useInfiniteQuery({
    queryKey: qk.processes.activity(id ?? ''),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Page<ActivityRow>>(`/processes/${seg(id ?? '')}/activity`, {
        query: { cursor: pageParam },
        signal,
      }),
    ...cursorPaging,
    enabled: Boolean(id),
    refetchInterval: POLL.activity,
  });
}

/** Read-only, so a query keyed by the request; `null` pauses it (while the source is unset). */
export function usePreviewFilter(req: FilterPreviewRequest | null) {
  return useQuery({
    queryKey: qk.preview.filter(req ?? { sourceId: '', eventTypes: [] }),
    queryFn: ({ signal }) =>
      apiFetch<FilterPreviewResponse>('/processes/preview/filter', {
        method: 'POST',
        body: req,
        signal,
      }),
    enabled: req != null && req.sourceId !== '',
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function usePreviewInput(req: InputPreviewRequest | null) {
  return useQuery({
    queryKey: qk.preview.input(req ?? ({} as InputPreviewRequest)),
    queryFn: ({ signal }) =>
      apiFetch<InputPreviewResponse>('/processes/preview/input', {
        method: 'POST',
        body: req,
        signal,
      }),
    enabled: req != null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function usePreviewCron(req: CronPreviewRequest | null) {
  return useQuery({
    queryKey: qk.preview.cron(req ?? { cron: '', timezone: '' }),
    queryFn: ({ signal }) =>
      apiFetch<CronPreviewResponse>('/processes/preview/cron', {
        method: 'POST',
        body: req,
        signal,
      }),
    enabled: req != null && req.cron.trim() !== '',
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useCreateProcess() {
  return useApiMutation<CreateProcessRequest, ProcessDetail>({
    method: 'POST',
    path: () => '/processes',
    invalidate: fleet,
  });
}

/** 409 when `expectedVersion` is stale. */
export function useUpdateProcess() {
  return useApiMutation<UpdateProcessRequest & { id: string }, ProcessDetail>({
    method: 'PUT',
    path: (v) => `/processes/${seg(v.id)}`,
    invalidate: fleet,
  });
}

/** Leaves the deleted process's own queries alone: a refetch would 404 while navigating away. */
export function useDeleteProcess() {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/processes/${seg(v.id)}`,
    invalidate: [qk.processes.list(), qk.board, qk.status, qk.approvals.all],
  });
}

export function useEnableProcess() {
  return useApiMutation<EnableRequest & { id: string }, ProcessDetail>({
    method: 'POST',
    path: (v) => `/processes/${seg(v.id)}/enable`,
    invalidate: fleet,
  });
}

export function useRunProcess() {
  return useApiMutation<
    RunNowRequest & { id: string },
    { batchId: string; runId: string | null; outcome: BatchOutcome }
  >({
    method: 'POST',
    path: (v) => `/processes/${seg(v.id)}/run`,
    // `batchId` is a body field here (the test-run batch), not a path parameter.
    body: ({ id: _id, ...body }) => body,
    invalidate: [...fleet, qk.runs.all, qk.events.all],
  });
}

export function useResetBreaker() {
  return useApiMutation<Reasoned & { id: string }, ProcessDetail>({
    method: 'POST',
    path: (v) => `/processes/${seg(v.id)}/breaker/reset`,
    invalidate: fleet,
  });
}

export function useRestoreProcessVersion() {
  return useApiMutation<Reasoned & { id: string; version: number }, ProcessDetail>({
    method: 'POST',
    path: (v) => `/processes/${seg(v.id)}/versions/${seg(v.version)}/restore`,
    invalidate: fleet,
  });
}
