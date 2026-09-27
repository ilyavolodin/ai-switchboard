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
  UserDTO,
} from '@ai-switchboard/core/contract';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { qk } from '../keys.js';
import { seg, useApiMutation } from '../mutation.js';
import { cursorPaging } from '../query.js';

/** GET /settings */
export function useSettings() {
  return useQuery({
    queryKey: qk.settings,
    queryFn: ({ signal }) => apiFetch<GlobalSettings>('/settings', { signal }),
  });
}

/** PUT /settings (admin) */
export function useUpdateSettings() {
  return useApiMutation<UpdateSettingsRequest, GlobalSettings>({
    method: 'PUT',
    path: () => '/settings',
    invalidate: [qk.settings, qk.me, qk.status],
  });
}

/** GET /users (admin) */
export function useUsers() {
  return useQuery({
    queryKey: qk.users,
    queryFn: ({ signal }) => apiFetch<UserDTO[]>('/users', { signal }),
  });
}

/** POST /users (admin) */
export function useCreateUser() {
  return useApiMutation<CreateUserRequest, UserDTO>({
    method: 'POST',
    path: () => '/users',
    invalidate: [qk.users],
  });
}

/** PUT /users/:id (admin) — change role. */
export function useUpdateUser() {
  return useApiMutation<UpdateUserRequest & { id: string }, UserDTO>({
    method: 'PUT',
    path: (v) => `/users/${seg(v.id)}`,
    invalidate: [qk.users, qk.me],
  });
}

/** DELETE /users/:id (admin) */
export function useDeleteUser() {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/users/${seg(v.id)}`,
    invalidate: [qk.users],
  });
}

/** POST /users/:id/sessions/revoke (admin) — signs the user out everywhere. */
export function useRevokeUserSessions() {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'POST',
    path: (v) => `/users/${seg(v.id)}/sessions/revoke`,
    invalidate: [qk.users],
  });
}

/**
 * PUT /users/:id/password (admin) — set or reset a temporary password. The user must change it at
 * their next password sign-in, and every session they have ends.
 */
export function useSetUserPassword() {
  return useApiMutation<SetPasswordRequest & { id: string }, UserDTO>({
    method: 'PUT',
    path: (v) => `/users/${seg(v.id)}/password`,
    invalidate: [qk.users],
  });
}

/** DELETE /users/:id/password (admin) — the account becomes OIDC-only. */
export function useRemoveUserPassword() {
  return useApiMutation<Reasoned & { id: string }, UserDTO>({
    method: 'DELETE',
    path: (v) => `/users/${seg(v.id)}/password`,
    invalidate: [qk.users],
  });
}

/** GET /tokens — the signed-in user's API tokens. */
export function useTokens() {
  return useQuery({
    queryKey: qk.tokens,
    queryFn: ({ signal }) => apiFetch<ApiTokenDTO[]>('/tokens', { signal }),
  });
}

/** POST /tokens — the secret is in the response once; show it and never store it. */
export function useCreateToken() {
  return useApiMutation<CreateApiTokenRequest, CreateApiTokenResponse>({
    method: 'POST',
    path: () => '/tokens',
    invalidate: [qk.tokens],
  });
}

/** DELETE /tokens/:id — revoke. */
export function useDeleteToken() {
  return useApiMutation<Reasoned & { id: string }, undefined>({
    method: 'DELETE',
    path: (v) => `/tokens/${seg(v.id)}`,
    invalidate: [qk.tokens],
  });
}

/** GET /audit?scope=&target=&actor=&cursor= (paged) */
export function useAudit(query: Omit<AuditQuery, 'cursor'> = {}) {
  return useInfiniteQuery({
    queryKey: qk.audit(query),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<Page<AuditEntry>>('/audit', { query: { ...query, cursor: pageParam }, signal }),
    ...cursorPaging,
  });
}

/** GET /export — the whole configuration as YAML (secret references intact, values absent). */
export function useExportYaml() {
  return useMutation({
    mutationFn: () => apiFetch<string>('/export', { as: 'text' }),
  });
}

/** POST /apply (admin) — apply a YAML configuration; `dryRun` shows the changes only. */
export function useApply() {
  const qc = useQueryClient();
  return useMutation<ApplyResponse, Error, ApplyRequest>({
    mutationFn: (body) => apiFetch<ApplyResponse>('/apply', { method: 'POST', body }),
    onSuccess: async (res) => {
      if (!res.dryRun) await qc.invalidateQueries();
    },
  });
}

/** GET /about — version and replicas. */
export function useAbout() {
  return useQuery({
    queryKey: qk.about,
    queryFn: ({ signal }) => apiFetch<AboutResponse>('/about', { signal }),
    staleTime: 5 * 60_000,
  });
}
