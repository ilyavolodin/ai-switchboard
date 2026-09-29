import type { SourcePreviewRequest, StatsWindow } from '@ai-switchboard/core/contract';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { useApiMutation } from '../mutation.js';
import { cursorPaging, useIdQuery } from '../query.js';

const fleet = [qk.sources.all, qk.board, qk.status, qk.processes.all];

export function useSources() {
  return useQuery({
    queryKey: qk.sources.list(),
    queryFn: ({ signal }) => apiFetch('GET /sources', { signal }),
    refetchInterval: POLL.lists,
  });
}

export function useSource(id: string | undefined) {
  return useIdQuery('GET /sources/:id', id, qk.sources.detail, { refetchInterval: POLL.lists });
}

export function useSourceStats(id: string | undefined, window: StatsWindow = '24h') {
  return useIdQuery('GET /sources/:id/stats', id, (i) => qk.sources.stats(i, window), {
    query: { window },
  });
}

export function useSourceEvents(id: string | undefined, type?: string) {
  return useInfiniteQuery({
    queryKey: qk.sources.events(id ?? '', type),
    queryFn: ({ pageParam, signal }) =>
      apiFetch('GET /sources/:id/events', {
        params: { id: id ?? '' },
        query: { type, cursor: pageParam },
        signal,
      }),
    ...cursorPaging,
    enabled: Boolean(id),
  });
}

export function useCreateSource() {
  return useApiMutation('POST /sources', { invalidate: fleet });
}

export function useUpdateSource() {
  return useApiMutation('PUT /sources/:id', { invalidate: fleet });
}

export function useDeleteSource() {
  return useApiMutation('DELETE /sources/:id', { invalidate: fleet });
}

export function useEnableSource() {
  return useApiMutation('POST /sources/:id/enable', { invalidate: fleet });
}

export function useProvisionSource() {
  return useApiMutation('POST /sources/:id/provision', { invalidate: [qk.sources.all] });
}

export function useSendTestEvent() {
  return useApiMutation('POST /sources/:id/test-event', {
    invalidate: [qk.sources.all, qk.events.all, qk.board],
  });
}

export function useReloadSource() {
  return useApiMutation('POST /sources/:id/reload', { invalidate: fleet });
}

/** Read-only, so a query keyed by the request; `null` pauses it (no sample yet). */
export function usePreviewSource(req: SourcePreviewRequest | null) {
  return useQuery({
    queryKey: qk.preview.source(req ?? { typeId: '', settings: {}, request: { body: '' } }),
    queryFn: ({ signal }) => apiFetch('POST /sources/preview', { body: req ?? undefined, signal }),
    enabled: req != null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Never fetched on its own: call `refetch()` when the person asks for it (a stored delivery is a
 * sender's raw body).
 */
export function useLastDelivery(id: string | undefined) {
  return useQuery({
    queryKey: qk.sources.lastDelivery(id ?? ''),
    queryFn: ({ signal }) =>
      apiFetch('GET /sources/:id/last-delivery', { params: { id: id ?? '' }, signal }),
    enabled: false,
    retry: false,
  });
}
