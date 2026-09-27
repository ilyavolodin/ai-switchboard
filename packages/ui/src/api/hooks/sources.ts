import type {
  ActivityRow,
  CreateSourceRequest,
  EnableRequest,
  Page,
  Reasoned,
  SourceDetail,
  SourceStatsResponse,
  SourceSummary,
  StatsWindow,
  UpdateSourceRequest,
} from '@ai-switchboard/core/contract';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { seg, useApiMutation } from '../mutation.js';

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
  return useQuery({
    queryKey: qk.sources.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<SourceDetail>(`/sources/${seg(id ?? '')}`, { signal }),
    enabled: Boolean(id),
    refetchInterval: POLL.lists,
  });
}

/** GET /sources/:id/stats?window= */
export function useSourceStats(id: string | undefined, window: StatsWindow = '24h') {
  return useQuery({
    queryKey: qk.sources.stats(id ?? '', window),
    queryFn: ({ signal }) =>
      apiFetch<SourceStatsResponse>(`/sources/${seg(id ?? '')}/stats`, {
        query: { window },
        signal,
      }),
    enabled: Boolean(id),
  });
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
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
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
