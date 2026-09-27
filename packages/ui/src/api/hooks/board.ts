import type {
  BoardResponse,
  PluginKind,
  PluginTypeDTO,
  StatusStripResponse,
} from '@ai-switchboard/core/contract';
import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';

/** GET /status — the top bar's capacity strip, open breakers and pending approvals. Polls 10 s. */
export function useStatus() {
  return useQuery({
    queryKey: qk.status,
    queryFn: ({ signal }) => apiFetch<StatusStripResponse>('/status', { signal }),
    refetchInterval: POLL.live,
  });
}

/** GET /board — nodes, edges and the needs-attention list. Polls 10 s. */
export function useBoard() {
  return useQuery({
    queryKey: qk.board,
    queryFn: ({ signal }) => apiFetch<BoardResponse>('/board', { signal }),
    refetchInterval: POLL.live,
  });
}

/** GET /plugin-types?kind= — installed types to create instances from (with their schemas). */
export function usePluginTypes(kind?: PluginKind) {
  return useQuery({
    queryKey: qk.pluginTypes(kind),
    queryFn: ({ signal }) =>
      apiFetch<PluginTypeDTO[]>('/plugin-types', { query: { kind }, signal }),
    staleTime: 5 * 60_000,
  });
}
