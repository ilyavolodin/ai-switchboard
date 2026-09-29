import type {
  CronPreviewRequest,
  FilterPreviewRequest,
  InputPreviewRequest,
  StatsWindow,
} from '@ai-switchboard/core/contract';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { useApiMutation } from '../mutation.js';
import { cursorPaging, useIdQuery } from '../query.js';

const fleet = [qk.processes.all, qk.board, qk.status, qk.approvals.all];

export function useProcesses() {
  return useQuery({
    queryKey: qk.processes.list(),
    queryFn: ({ signal }) => apiFetch('GET /processes', { signal }),
    refetchInterval: POLL.lists,
  });
}

export function useProcess(id: string | undefined) {
  return useIdQuery('GET /processes/:id', id, qk.processes.detail, {
    refetchInterval: POLL.lists,
  });
}

export function useProcessFunnel(id: string | undefined, window: StatsWindow = '7d') {
  return useIdQuery('GET /processes/:id/funnel', id, (i) => qk.processes.funnel(i, window), {
    query: { window },
  });
}

export function useProcessStats(id: string | undefined, window: StatsWindow = '7d') {
  return useIdQuery('GET /processes/:id/stats', id, (i) => qk.processes.stats(i, window), {
    query: { window },
  });
}

export function useProcessVersions(id: string | undefined) {
  return useIdQuery('GET /processes/:id/versions', id, qk.processes.versions);
}

export function useProcessVersion(id: string | undefined, version: number | undefined) {
  return useQuery({
    queryKey: qk.processes.version(id ?? '', version ?? 0),
    queryFn: ({ signal }) =>
      apiFetch('GET /processes/:id/versions/:version', {
        params: { id: id ?? '', version: version ?? 0 },
        signal,
      }),
    enabled: Boolean(id) && version != null,
  });
}

export function useProcessBatches(id: string | undefined, limit = 20) {
  return useIdQuery('GET /processes/:id/batches', id, (i) => qk.processes.batches(i, limit), {
    query: { limit },
  });
}

export function useProcessActivity(id: string | undefined) {
  return useInfiniteQuery({
    queryKey: qk.processes.activity(id ?? ''),
    queryFn: ({ pageParam, signal }) =>
      apiFetch('GET /processes/:id/activity', {
        params: { id: id ?? '' },
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
      apiFetch('POST /processes/preview/filter', { body: req ?? undefined, signal }),
    enabled: req != null && req.sourceId !== '',
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function usePreviewInput(req: InputPreviewRequest | null) {
  return useQuery({
    queryKey: qk.preview.input(req),
    queryFn: ({ signal }) =>
      apiFetch('POST /processes/preview/input', { body: req ?? undefined, signal }),
    enabled: req != null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function usePreviewCron(req: CronPreviewRequest | null) {
  return useQuery({
    queryKey: qk.preview.cron(req ?? { cron: '', timezone: '' }),
    queryFn: ({ signal }) =>
      apiFetch('POST /processes/preview/cron', { body: req ?? undefined, signal }),
    enabled: req != null && req.cron.trim() !== '',
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useCreateProcess() {
  return useApiMutation('POST /processes', { invalidate: fleet });
}

/** 409 when `expectedVersion` is stale. */
export function useUpdateProcess() {
  return useApiMutation('PUT /processes/:id', { invalidate: fleet });
}

/** Leaves the deleted process's own queries alone: a refetch would 404 while navigating away. */
export function useDeleteProcess() {
  return useApiMutation('DELETE /processes/:id', {
    invalidate: [qk.processes.list(), qk.board, qk.status, qk.approvals.all],
  });
}

export function useEnableProcess() {
  return useApiMutation('POST /processes/:id/enable', { invalidate: fleet });
}

export function useRunProcess() {
  return useApiMutation('POST /processes/:id/run', {
    invalidate: [...fleet, qk.runs.all, qk.events.all],
  });
}

export function useResetBreaker() {
  return useApiMutation('POST /processes/:id/breaker/reset', { invalidate: fleet });
}

export function useRestoreProcessVersion() {
  return useApiMutation('POST /processes/:id/versions/:version/restore', { invalidate: fleet });
}
