import type {
  ActivityRow,
  CreateSourceRequest,
  EnableRequest,
  LastDeliveryResponse,
  Page,
  Reasoned,
  SourceDetail,
  SourcePreviewRequest,
  SourcePreviewResponse,
  SourceStatsResponse,
  SourceSummary,
  StatsWindow,
  UpdateSourceRequest,
} from '@ai-switchboard/core/contract';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { seg, useApiMutation } from '../mutation.js';
import { cursorPaging, useIdQuery } from '../query.js';

const fleet = [qk.sources.all, qk.board, qk.status, qk.processes.all];

/** GET /sources */
export function useSources() {
  return useQuery({
    queryKey: qk.sources.list(),
    queryFn: ({ signal }) => apiFetch<SourceSummary[]>('/sources', { signal }),
    refetchInterval: POLL.lists,
  });
}

/** GET /sources/:id */
export function useSource(id: string | undefined) {
  return useIdQuery<SourceDetail>(id, qk.sources.detail, (i) => `/sources/${seg(i)}`, {
    refetchInterval: POLL.lists,
  });
}

/** GET /sources/:id/stats?window= */
export function useSourceStats(id: string | undefined, window: StatsWindow = '24h') {
  return useIdQuery<SourceStatsResponse>(
    id,
    (i) => qk.sources.stats(i, window),
    (i) => `/sources/${seg(i)}/stats`,
    { query: { window } },
  );
}

/** GET /sources/:id/events?cursor=&type= (paged) */
export function useSourceEvents(id: string | undefined, type?: string) {
  return useInfiniteQuery({
    queryKey: qk.sources.events(id ?? '', type),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Page<ActivityRow>>(`/sources/${seg(id ?? '')}/events`, {
        query: { type, cursor: pageParam },
        signal,
      }),
    ...cursorPaging,
    enabled: Boolean(id),
  });
}

/** POST /sources */
export function useCreateSource() {
  return useApiMutation<CreateSourceRequest, SourceDetail>({
    method: 'POST',
    path: () => '/sources',
    invalidate: fleet,
  });
}

/** PUT /sources/:id */
export function useUpdateSource() {
  return useApiMutation<UpdateSourceRequest & { id: string }, SourceDetail>({
    method: 'PUT',
    path: (v) => `/sources/${seg(v.id)}`,
    invalidate: fleet,
  });
}

/** DELETE /sources/:id */
export function useDeleteSource() {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/sources/${seg(v.id)}`,
    invalidate: fleet,
  });
}

/** POST /sources/:id/enable */
export function useEnableSource() {
  return useApiMutation<EnableRequest & { id: string }, SourceDetail>({
    method: 'POST',
    path: (v) => `/sources/${seg(v.id)}/enable`,
    invalidate: fleet,
  });
}

/** POST /sources/:id/provision — register the webhook with the upstream system. */
export function useProvisionSource() {
  return useApiMutation<Reasoned & { id: string }, { ok: boolean; message: string }>({
    method: 'POST',
    path: (v) => `/sources/${seg(v.id)}/provision`,
    invalidate: [qk.sources.all],
  });
}

/** POST /sources/:id/test-event */
export function useSendTestEvent() {
  return useApiMutation<Reasoned & { id: string; type?: string }, { eventIds: string[] }>({
    method: 'POST',
    path: (v) => `/sources/${seg(v.id)}/test-event`,
    invalidate: [qk.sources.all, qk.events.all, qk.board],
  });
}

/** POST /sources/:id/reload — recreate the live plugin object. */
export function useReloadSource() {
  return useApiMutation<Reasoned & { id: string }, SourceDetail>({
    method: 'POST',
    path: (v) => `/sources/${seg(v.id)}/reload`,
    invalidate: fleet,
  });
}

/**
 * POST /sources/preview — a sample delivery through draft settings (Add source, Source ›
 * Settings). Read-only, so a query keyed by the request; pass `null` to pause (no sample yet).
 */
export function usePreviewSource(req: SourcePreviewRequest | null) {
  return useQuery({
    queryKey: qk.preview.source(req ?? { typeId: '', settings: {}, request: { body: '' } }),
    queryFn: ({ signal }) =>
      apiFetch<SourcePreviewResponse>('/sources/preview', { method: 'POST', body: req, signal }),
    enabled: req != null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * GET /sources/:id/last-delivery — never fetched on its own: call `refetch()` when the person
 * asks for it (a stored delivery is a sender's raw body).
 */
export function useLastDelivery(id: string | undefined) {
  return useQuery({
    queryKey: qk.sources.lastDelivery(id ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<LastDeliveryResponse>(`/sources/${seg(id ?? '')}/last-delivery`, { signal }),
    enabled: false,
    retry: false,
  });
}
