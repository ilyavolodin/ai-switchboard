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
import { cursorPaging, useIdQuery } from '../query.js';

export function useEvents(query: Omit<ActivityQuery, 'cursor'> = {}) {
  return useInfiniteQuery({
    queryKey: qk.events.list(query),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Page<ActivityRow>>('/events', {
        query: { ...query, cursor: pageParam },
        signal,
      }),
    ...cursorPaging,
    refetchInterval: POLL.activity,
  });
}

export function useEvent(id: string | undefined, opts: { untilMatched?: boolean } = {}) {
  return useQuery({
    queryKey: qk.events.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<EventDetail>(`/events/${seg(id ?? '')}`, { signal }),
    enabled: Boolean(id),
    // A just-sent event is matched by a queue job: poll briefly until it leaves `received`.
    ...(opts.untilMatched
      ? {
          refetchInterval: (q: { state: { data?: EventDetail; dataUpdateCount: number } }) =>
            q.state.data?.stage === 'received' && q.state.dataUpdateCount < 20 ? 1500 : false,
        }
      : {}),
  });
}

export function useEventTrace(id: string | undefined) {
  return useIdQuery<TraceResponse>(id, qk.events.trace, (i) => `/events/${seg(i)}/trace`);
}

/** `artifact` is an artifact id, `kind:id`, or `#482`. */
export function useTrace(artifact: string | undefined) {
  return useQuery({
    queryKey: qk.trace(artifact ?? ''),
    queryFn: ({ signal }) => apiFetch<TraceResponse>('/trace', { query: { artifact }, signal }),
    enabled: Boolean(artifact),
  });
}

export function useReplayEvent() {
  return useApiMutation<Reasoned & { id: string }, { eventIds: string[] }>({
    method: 'POST',
    path: (v) => `/events/${seg(v.id)}/replay`,
    invalidate: [qk.events.all, qk.board, qk.sources.all, qk.processes.all],
  });
}

export function useRuns(query: Omit<RunsQuery, 'cursor'> = {}) {
  return useInfiniteQuery({
    queryKey: qk.runs.list(query),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Page<RunSummary>>('/runs', { query: { ...query, cursor: pageParam }, signal }),
    ...cursorPaging,
    refetchInterval: POLL.activity,
  });
}

export function useRun(id: string | undefined) {
  return useIdQuery<RunDetail>(id, qk.runs.detail, (i) => `/runs/${seg(i)}`);
}

export function useCloseRun() {
  return useApiMutation<CloseRunRequest & { id: string }, RunDetail>({
    method: 'POST',
    path: (v) => `/runs/${seg(v.id)}/close`,
    // Settling a run can change a breaker's failure count, so the status strip refreshes too.
    invalidate: [qk.runs.all, qk.processes.all, qk.board, qk.status],
  });
}
