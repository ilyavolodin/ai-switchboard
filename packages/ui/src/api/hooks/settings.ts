import type { ApplyRequest, AuditQuery } from '@ai-switchboard/core/contract';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { qk } from '../keys.js';
import { useApiMutation } from '../mutation.js';
import { cursorPaging } from '../query.js';

export function useSettings() {
  return useQuery({
    queryKey: qk.settings,
    queryFn: ({ signal }) => apiFetch('GET /settings', { signal }),
  });
}

export function useUpdateSettings() {
  return useApiMutation('PUT /settings', { invalidate: [qk.settings, qk.me, qk.status] });
}

export function useUsers() {
  return useQuery({
    queryKey: qk.users,
    queryFn: ({ signal }) => apiFetch('GET /users', { signal }),
  });
}

export function useUserDirectory(enabled = true) {
  return useQuery({
    queryKey: [...qk.users, 'directory'],
    queryFn: ({ signal }) => apiFetch('GET /users/directory', { signal }),
    enabled,
  });
}

export function useCreateUser() {
  return useApiMutation('POST /users', { invalidate: [qk.users] });
}

export function useUpdateUser() {
  return useApiMutation('PUT /users/:id', { invalidate: [qk.users, qk.me] });
}

export function useDeleteUser() {
  return useApiMutation('DELETE /users/:id', { invalidate: [qk.users] });
}

export function useRevokeUserSessions() {
  return useApiMutation('POST /users/:id/sessions/revoke', { invalidate: [qk.users] });
}

export function useSetUserPassword() {
  return useApiMutation('PUT /users/:id/password', { invalidate: [qk.users] });
}

/** The account becomes OIDC-only. */
export function useRemoveUserPassword() {
  return useApiMutation('DELETE /users/:id/password', { invalidate: [qk.users] });
}

export function useTokens() {
  return useQuery({
    queryKey: qk.tokens,
    queryFn: ({ signal }) => apiFetch('GET /tokens', { signal }),
  });
}

/** The secret is in the response once; show it and never store it. */
export function useCreateToken() {
  return useApiMutation('POST /tokens', { invalidate: [qk.tokens] });
}

export function useDeleteToken() {
  return useApiMutation('DELETE /tokens/:id', { invalidate: [qk.tokens] });
}

export function useAudit(query: Omit<AuditQuery, 'cursor'> = {}) {
  return useInfiniteQuery({
    queryKey: qk.audit(query),
    queryFn: ({ pageParam, signal }) =>
      apiFetch('GET /audit', { query: { ...query, cursor: pageParam }, signal }),
    ...cursorPaging,
  });
}

/** Secret references intact, values absent. */
export function useExportYaml() {
  return useMutation({ mutationFn: () => apiFetch('GET /export') });
}

export function useApply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ApplyRequest) => apiFetch('POST /apply', { body }),
    onSuccess: async (res) => {
      if (!res.dryRun) await qc.invalidateQueries();
    },
  });
}

export function useAbout() {
  return useQuery({
    queryKey: qk.about,
    queryFn: ({ signal }) => apiFetch('GET /about', { signal }),
    staleTime: 5 * 60_000,
  });
}
