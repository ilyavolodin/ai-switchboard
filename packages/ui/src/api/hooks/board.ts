import type {
  BoardResponse,
  PluginKind,
  PluginTypeDTO,
  StatusStripResponse,
} from '@ai-switchboard/core/contract';
import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';

export function useStatus() {
  return useQuery({
    queryKey: qk.status,
    queryFn: ({ signal }) => apiFetch<StatusStripResponse>('/status', { signal }),
    refetchInterval: POLL.live,
  });
}

export function useBoard() {
  return useQuery({
    queryKey: qk.board,
    queryFn: ({ signal }) => apiFetch<BoardResponse>('/board', { signal }),
    refetchInterval: POLL.live,
  });
}

export function usePluginTypes(kind?: PluginKind) {
  return useQuery({
    queryKey: qk.pluginTypes(kind),
    queryFn: ({ signal }) =>
      apiFetch<PluginTypeDTO[]>('/plugin-types', { query: { kind }, signal }),
    staleTime: 5 * 60_000,
  });
}
