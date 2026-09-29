import type {
  AboutResponse,
  ApiTokenDTO,
  ApplyRequest,
  ApplyResponse,
  AuditEntry,
  AuditQuery,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  CreateUserRequest,
  GlobalSettings,
  Page,
  Reasoned,
  SetPasswordRequest,
  UpdateSettingsRequest,
  UpdateUserRequest,
  UserDirectoryEntry,
  UserDTO,
} from '@ai-switchboard/core/contract';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { qk } from '../keys.js';
import { seg, useApiMutation } from '../mutation.js';
import { cursorPaging } from '../query.js';

export function useSettings() {
  return useQuery({
    queryKey: qk.settings,
    queryFn: ({ signal }) => apiFetch<GlobalSettings>('/settings', { signal }),
  });
}

export function useUpdateSettings() {
  return useApiMutation<UpdateSettingsRequest, GlobalSettings>({
    method: 'PUT',
    path: () => '/settings',
    invalidate: [qk.settings, qk.me, qk.status],
  });
}

export function useUsers() {
  return useQuery({
    queryKey: qk.users,
    queryFn: ({ signal }) => apiFetch<UserDTO[]>('/users', { signal }),
  });
}

export function useUserDirectory(enabled = true) {
  return useQuery({
    queryKey: [...qk.users, 'directory'],
    queryFn: ({ signal }) => apiFetch<UserDirectoryEntry[]>('/users/directory', { signal }),
    enabled,
  });
}

export function useCreateUser() {
  return useApiMutation<CreateUserRequest, UserDTO>({
    method: 'POST',
    path: () => '/users',
    invalidate: [qk.users],
  });
}

export function useUpdateUser() {
  return useApiMutation<UpdateUserRequest & { id: string }, UserDTO>({
    method: 'PUT',
    path: (v) => `/users/${seg(v.id)}`,
    invalidate: [qk.users, qk.me],
  });
}

export function useDeleteUser() {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/users/${seg(v.id)}`,
    invalidate: [qk.users],
  });
}

export function useRevokeUserSessions() {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'POST',
    path: (v) => `/users/${seg(v.id)}/sessions/revoke`,
    invalidate: [qk.users],
  });
}

export function useSetUserPassword() {
  return useApiMutation<SetPasswordRequest & { id: string }, UserDTO>({
    method: 'PUT',
    path: (v) => `/users/${seg(v.id)}/password`,
    invalidate: [qk.users],
  });
}

/** The account becomes OIDC-only. */
export function useRemoveUserPassword() {
  return useApiMutation<Reasoned & { id: string }, UserDTO>({
    method: 'DELETE',
    path: (v) => `/users/${seg(v.id)}/password`,
    invalidate: [qk.users],
  });
}

export function useTokens() {
  return useQuery({
    queryKey: qk.tokens,
    queryFn: ({ signal }) => apiFetch<ApiTokenDTO[]>('/tokens', { signal }),
  });
}

/** The secret is in the response once; show it and never store it. */
export function useCreateToken() {
  return useApiMutation<CreateApiTokenRequest, CreateApiTokenResponse>({
    method: 'POST',
    path: () => '/tokens',
    invalidate: [qk.tokens],
  });
}

export function useDeleteToken() {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/tokens/${seg(v.id)}`,
    invalidate: [qk.tokens],
  });
}

export function useAudit(query: Omit<AuditQuery, 'cursor'> = {}) {
  return useInfiniteQuery({
    queryKey: qk.audit(query),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Page<AuditEntry>>('/audit', { query: { ...query, cursor: pageParam }, signal }),
    ...cursorPaging,
  });
}

/** Secret references intact, values absent. */
export function useExportYaml() {
  return useMutation({
    mutationFn: () => apiFetch<string>('/export', { as: 'text' }),
  });
}

export function useApply() {
  const qc = useQueryClient();
  return useMutation<ApplyResponse, Error, ApplyRequest>({
    mutationFn: (body) => apiFetch<ApplyResponse>('/apply', { method: 'POST', body }),
    onSuccess: async (res) => {
      if (!res.dryRun) await qc.invalidateQueries();
    },
  });
}

export function useAbout() {
  return useQuery({
    queryKey: qk.about,
    queryFn: ({ signal }) => apiFetch<AboutResponse>('/about', { signal }),
    staleTime: 5 * 60_000,
  });
}
