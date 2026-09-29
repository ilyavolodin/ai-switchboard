import type {
  ApprovalHistoryItem,
  ApprovalItem,
  ApprovalRulesResponse,
  BatchOutcome,
  Page,
  Reasoned,
} from '@ai-switchboard/core/contract';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { seg, useApiMutation } from '../mutation.js';
import { cursorPaging } from '../query.js';

const affected = [qk.approvals.all, qk.board, qk.status, qk.processes.all, qk.runs.all];

export function useApprovals() {
  return useQuery({
    queryKey: qk.approvals.pending(),
    queryFn: ({ signal }) => apiFetch<ApprovalItem[]>('/approvals', { signal }),
    refetchInterval: POLL.live,
  });
}

export function useApprovalHistory() {
  return useInfiniteQuery({
    queryKey: qk.approvals.history(),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Page<ApprovalHistoryItem>>('/approvals/history', {
        query: { cursor: pageParam },
        signal,
      }),
    ...cursorPaging,
  });
}

export function useApprovalRules() {
  return useQuery({
    queryKey: qk.approvals.rules(),
    queryFn: ({ signal }) => apiFetch<ApprovalRulesResponse>('/approvals/rules', { signal }),
  });
}

export function useApprove() {
  return useApiMutation<
    Reasoned & { batchId: string },
    { runId: string | null; outcome: BatchOutcome }
  >({
    method: 'POST',
    path: (v) => `/approvals/${seg(v.batchId)}/approve`,
    invalidate: affected,
  });
}

export function useReject() {
  return useApiMutation<Reasoned & { batchId: string }, undefined>({
    method: 'POST',
    path: (v) => `/approvals/${seg(v.batchId)}/reject`,
    invalidate: affected,
  });
}
