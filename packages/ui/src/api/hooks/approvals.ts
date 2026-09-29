import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { POLL, qk } from '../keys.js';
import { useApiMutation } from '../mutation.js';
import { cursorPaging } from '../query.js';

const affected = [qk.approvals.all, qk.board, qk.status, qk.processes.all, qk.runs.all];

export function useApprovals() {
  return useQuery({
    queryKey: qk.approvals.pending(),
    queryFn: ({ signal }) => apiFetch('GET /approvals', { signal }),
    refetchInterval: POLL.live,
  });
}

export function useApprovalHistory() {
  return useInfiniteQuery({
    queryKey: qk.approvals.history(),
    queryFn: ({ pageParam, signal }) =>
      apiFetch('GET /approvals/history', { query: { cursor: pageParam }, signal }),
    ...cursorPaging,
  });
}

export function useApprovalRules() {
  return useQuery({
    queryKey: qk.approvals.rules(),
    queryFn: ({ signal }) => apiFetch('GET /approvals/rules', { signal }),
  });
}

export function useApprove() {
  return useApiMutation('POST /approvals/:batchId/approve', { invalidate: affected });
}

export function useReject() {
  return useApiMutation('POST /approvals/:batchId/reject', { invalidate: affected });
}
