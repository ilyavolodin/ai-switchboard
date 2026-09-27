import type { MeResponse, Role, UserDTO } from '@ai-switchboard/core/contract';
import { createContext, useContext } from 'react';

/** The signed-in session as the shell resolved it from `GET /auth/me`. */
export interface Session {
  user: UserDTO | null;
  authMode: MeResponse['authMode'];
  oidcConfigured: boolean;
  evaluation: boolean;
}

/** Filled by the app shell; tests use `renderWithProviders({ role })`. */
export const SessionContext = createContext<Session>({
  user: null,
  authMode: 'local',
  oidcConfigured: false,
  evaluation: false,
});

/** viewer < operator < admin. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

/** "Operator", "Admin", "Viewer". */
export function roleLabel(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** The current session. */
export function useSession(): Session {
  return useContext(SessionContext);
}

/** True when the signed-in user has at least `role`. Signed out is never allowed. */
export function useCan(role: Role): boolean {
  const { user } = useSession();
  return user != null && ROLE_RANK[user.role] >= ROLE_RANK[role];
}

/** The tooltip a disabled control shows to someone without the role. */
export function roleRequiredMessage(role: Role, current: Role | undefined): string {
  return `${current ? `${roleLabel(current)} role · ` : ''}needs the ${roleLabel(role)} role`;
}
