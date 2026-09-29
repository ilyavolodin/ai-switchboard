import type { MeResponse, Role, UserDTO } from '@ai-switchboard/core/contract';
import { createContext, useContext } from 'react';

export interface Session {
  user: UserDTO | null;
  authMode: MeResponse['authMode'];
  oidcConfigured: boolean;
  evaluation: boolean;
  /** When false the reason prompt is skipped; destructive actions still confirm. */
  requireReasons: boolean;
}

export const SessionContext = createContext<Session>({
  user: null,
  authMode: 'local',
  oidcConfigured: false,
  evaluation: false,
  requireReasons: true,
});

export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function roleLabel(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function useSession(): Session {
  return useContext(SessionContext);
}

/** Signed out is never allowed. */
export function useCan(role: Role): boolean {
  const { user } = useSession();
  return user != null && ROLE_RANK[user.role] >= ROLE_RANK[role];
}

export function roleRequiredMessage(role: Role, current: Role | undefined): string {
  return `${current ? `${roleLabel(current)} role · ` : ''}needs the ${roleLabel(role)} role`;
}
