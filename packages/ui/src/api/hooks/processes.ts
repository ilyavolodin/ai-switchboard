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

const fleet = [qk.processes.all, qk.board, qk.status, qk.approvals.all];

/** GET /processes */
export function useProcesses() {
  return useQuery({
    queryKey: qk.processes.list(),
    queryFn: ({ signal }) => apiFetch<ProcessSummary[]>('/processes', { signal }),
    refetchInterval: POLL.lists,
  });
}

/** GET /processes/:id */
export function useProcess(id: string | undefined) {
  return useQuery({
    queryKey: qk.processes.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<ProcessDetail>(`/processes/${seg(id ?? '')}`, { signal }),
    enabled: Boolean(id),
    refetchInterval: POLL.lists,
  });
}

/** GET /processes/:id/funnel?window= */
export function useProcessFunnel(id: string | undefined, window: StatsWindow = '7d') {
  return useQuery({
    queryKey: qk.processes.funnel(id ?? '', window),
    queryFn: ({ signal }) =>
      apiFetch<FunnelResponse>(`/processes/${seg(id ?? '')}/funnel`, { query: { window }, signal }),
    enabled: Boolean(id),
  });
}

/** GET /processes/:id/stats?window= */
export function useProcessStats(id: string | undefined, window: StatsWindow = '7d') {
  return useQuery({
    queryKey: qk.processes.stats(id ?? '', window),
    queryFn: ({ signal }) =>
      apiFetch<ProcessStatsResponse>(`/processes/${seg(id ?? '')}/stats`, {
        query: { window },
        signal,
      }),
    enabled: Boolean(id),
  });
}

/** GET /processes/:id/versions */
export function useProcessVersions(id: string | undefined) {
  return useQuery({
    queryKey: qk.processes.versions(id ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<ProcessVersionSummary[]>(`/processes/${seg(id ?? '')}/versions`, { signal }),
    enabled: Boolean(id),
  });
}

/** GET /processes/:id/versions/:version */
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

/** GET /processes/:id/batches?limit= — recent batches, e.g. to pick one for a test run. */
export function useProcessBatches(id: string | undefined, limit = 20) {
  return useQuery({
    queryKey: qk.processes.batches(id ?? '', limit),
    queryFn: ({ signal }) =>
      apiFetch<RecentBatchDTO[]>(`/processes/${seg(id ?? '')}/batches`, {
        query: { limit },
        signal,
      }),
    enabled: Boolean(id),
  });
}

/** GET /processes/:id/activity?cursor= (paged) */
export function useProcessActivity(id: string | undefined) {
  return useInfiniteQuery({
    queryKey: qk.processes.activity(id ?? ''),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Page<ActivityRow>>(`/processes/${seg(id ?? '')}/activity`, {
        query: { cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(id),
    refetchInterval: POLL.activity,
  });
}

/**
 * POST /processes/preview/filter — evaluates a filter against the last real events. Read-only, so
 * it is a query keyed by the request; pass `null` to pause (e.g. while the source is unset).
 */
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

/** POST /processes/preview/input — runs the input mapping against a batch and validates it. */
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

/** POST /processes/preview/cron — description and the next fire times in a timezone. */
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

/** POST /processes */
export function useCreateProcess() {
  return useApiMutation<CreateProcessRequest, ProcessDetail>({
    method: 'POST',
    path: () => '/processes',
    invalidate: fleet,
  });
}

/** PUT /processes/:id — 409 when `expectedVersion` is stale. */
export function useUpdateProcess() {
  return useApiMutation<UpdateProcessRequest & { id: string }, ProcessDetail>({
    method: 'PUT',
    path: (v) => `/processes/${seg(v.id)}`,
    invalidate: fleet,
  });
}

/** DELETE /processes/:id */
export function useDeleteProcess() {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/processes/${seg(v.id)}`,
    invalidate: fleet,
  });
}

/** POST /processes/:id/enable */
export function useEnableProcess() {
  return useApiMutation<EnableRequest & { id: string }, ProcessDetail>({
    method: 'POST',
    path: (v) => `/processes/${seg(v.id)}/enable`,
    invalidate: fleet,
  });
}

/** POST /processes/:id/run — run now, optionally dry and/or with a recent batch's events. */
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

/** POST /processes/:id/breaker/reset */
export function useResetBreaker() {
  return useApiMutation<Reasoned & { id: string }, ProcessDetail>({
    method: 'POST',
    path: (v) => `/processes/${seg(v.id)}/breaker/reset`,
    invalidate: fleet,
  });
}

/** POST /processes/:id/versions/:version/restore */
export function useRestoreProcessVersion() {
  return useApiMutation<Reasoned & { id: string; version: number }, ProcessDetail>({
    method: 'POST',
    path: (v) => `/processes/${seg(v.id)}/versions/${seg(v.version)}/restore`,
    invalidate: fleet,
  });
}
