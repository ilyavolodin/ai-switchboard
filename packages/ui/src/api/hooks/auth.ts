import type { LocalLoginRequest, MeResponse } from '@ai-switchboard/core/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../client.js';
import { qk } from '../keys.js';

/** GET /auth/me — the signed-in user (null when signed out), auth mode and evaluation flag. */
export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => apiFetch<MeResponse>('/auth/me', { signal }),
    staleTime: 60_000,
    retry: 1,
  });
}

/** POST /auth/login (local mode) — stores the returned session in the `me` query. */
export function useLogin() {
  const qc = useQueryClient();
  return useMutation<MeResponse, Error, LocalLoginRequest>({
    mutationFn: (body) => apiFetch<MeResponse>('/auth/login', { method: 'POST', body }),
    onSuccess: (me) => {
      qc.setQueryData(qk.me, me);
    },
  });
}

/** POST /auth/logout — clears every cached query. */
export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<undefined>('/auth/logout', { method: 'POST', body: {} }),
    onSuccess: async () => {
      qc.clear();
      await qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

/** GET /auth/whoami — the audit identity of the caller (`{ actor }`). */
export function useWhoami() {
  return useQuery({
    queryKey: [...qk.me, 'whoami'],
    queryFn: ({ signal }) => apiFetch<{ actor: string }>('/auth/whoami', { signal }),
    staleTime: 5 * 60_000,
  });
}

/** Where the OIDC sign-in button points (a full-page navigation, not a fetch). */
export const OIDC_START_URL = '/api/v1/auth/oidc/start';
