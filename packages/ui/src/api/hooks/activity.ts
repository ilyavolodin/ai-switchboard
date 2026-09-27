import type {
  ActivityQuery,
  ActivityRow,
  CloseRunRequest,
  EventDetail,
  Page,
  Reasoned,
  RunDetail,
  RunSummary,
  RunsQuery,
  TraceResponse,
} from '@ai-switchboard/core/contract';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { seg, useApiMutation } from '../mutation.js';

/** GET /events?source=&process=&executor=&stage=&artifact=&from=&to=&cursor= (paged) */
export function useEvents(query: Omit<ActivityQuery, 'cursor'> = {}) {
  return useInfiniteQuery({
    queryKey: qk.events.list(query),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Page<ActivityRow>>('/events', {
        query: { ...query, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: POLL.activity,
  });
}

/** GET /events/:id */
export function useEvent(id: string | undefined) {
  return useQuery({
    queryKey: qk.events.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<EventDetail>(`/events/${seg(id ?? '')}`, { signal }),
    enabled: Boolean(id),
  });
}

/** GET /events/:id/trace */
export function useEventTrace(id: string | undefined) {
  return useQuery({
    queryKey: qk.events.trace(id ?? ''),
    queryFn: ({ signal }) => apiFetch<TraceResponse>(`/events/${seg(id ?? '')}/trace`, { signal }),
    enabled: Boolean(id),
  });
}

/** GET /trace?artifact= — one timeline for an artifact id, `kind:id`, or `#482`. */
export function useTrace(artifact: string | undefined) {
  return useQuery({
    queryKey: qk.trace(artifact ?? ''),
    queryFn: ({ signal }) => apiFetch<TraceResponse>('/trace', { query: { artifact }, signal }),
    enabled: Boolean(artifact),
  });
}

/** POST /events/:id/replay — re-inject a stored raw body. */
export function useReplayEvent() {
  return useApiMutation<Reasoned & { id: string }, { eventIds: string[] }>({
    method: 'POST',
    path: (v) => `/events/${seg(v.id)}/replay`,
    invalidate: [qk.events.all, qk.board, qk.sources.all, qk.processes.all],
  });
}

/** GET /runs?process=&executor=&status=&cursor= (paged) */
export function useRuns(query: Omit<RunsQuery, 'cursor'> = {}) {
  return useInfiniteQuery({
    queryKey: qk.runs.list(query),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Page<RunSummary>>('/runs', { query: { ...query, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: POLL.activity,
  });
}

/** GET /runs/:id */
export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: qk.runs.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<RunDetail>(`/runs/${seg(id ?? '')}`, { signal }),
    enabled: Boolean(id),
  });
}

/** POST /runs/:id/close — settle an open run by hand. */
export function useCloseRun() {
  return useApiMutation<CloseRunRequest & { id: string }, RunDetail>({
    method: 'POST',
    path: (v) => `/runs/${seg(v.id)}/close`,
    invalidate: [qk.runs.all, qk.processes.all, qk.board],
  });
}
