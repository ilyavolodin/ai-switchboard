import type {
  ChangePasswordRequest,
  LocalLoginRequest,
  MeResponse,
} from '@ai-switchboard/core/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { qk } from '../keys.js';

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => apiFetch('GET /auth/me', { signal }),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation<MeResponse, Error, LocalLoginRequest>({
    mutationFn: (body) => apiFetch('POST /auth/login', { body }),
    onSuccess: (me) => {
      qc.setQueryData(qk.me, me);
    },
  });
}

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation<MeResponse, Error, ChangePasswordRequest>({
    mutationFn: (body) => apiFetch('POST /auth/password', { body }),
    onSuccess: async (me) => {
      qc.setQueryData(qk.me, me);
      // Queries that failed with password_change_required refetch now.
      await qc.invalidateQueries({
        predicate: (q) => !(q.queryKey.length === 1 && q.queryKey[0] === qk.me[0]),
      });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch('POST /auth/logout'),
    onSuccess: async () => {
      qc.clear();
      await qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

/** A full-page navigation target, not a fetch. */
export const OIDC_START_URL = '/api/v1/auth/oidc/start';
