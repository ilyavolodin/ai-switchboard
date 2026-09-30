import type { Role } from '@ai-switchboard/core/contract';
import { roleAtLeast, ROLE_RANK, ROLES } from '@ai-switchboard/core/domain';

import { roleLabel } from '../../app/session.js';
import { passwordError } from '../shared/passwordRules.js';

const byRank = [...ROLES].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);

export function roleOptions(roles: readonly Role[]) {
  return roles.map((r) => ({ value: r, label: roleLabel(r) }));
}

export const ROLE_OPTIONS = roleOptions(ROLES);

export const isRole = (v: string): v is Role => ROLES.some((r) => r === v);

/** Lowest first: a token can have your role or a lower one. */
export function grantableRoles(own: Role): Role[] {
  return byRank.filter((r) => roleAtLeast(own, r));
}

export function initials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

export interface NewUserCheck {
  email: string;
  emailError: string | null;
  passwordError: string | null;
}

/** Normalises the email and checks it; an empty password means "no password" and is allowed. */
export function checkNewUser(email: string, password: string): NewUserCheck {
  const value = email.trim().toLowerCase();
  return {
    email: value,
    emailError: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : 'Enter an email address',
    passwordError: password === '' ? null : passwordError(password, value),
  };
}
