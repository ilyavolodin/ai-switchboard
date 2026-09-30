import { PASSWORD_MAX_LENGTH } from '../auth/password-policy.js';
import { ROLES, type Role } from '../domain/status.js';
import type { Iso, Reasoned } from './common.js';
import { bodySchema } from './schema.js';

export interface UserDTO {
  id: string;
  email: string;
  role: Role;
  hasPassword: boolean;
  hasOidc: boolean;
  /** Set by an admin (or bootstrap): the next password sign-in must change it. */
  mustChangePassword: boolean;
  lastLoginAt: Iso | null;
  createdAt: Iso;
}

/** GET /users/directory, visible to every role: sign-in methods and times stay admin-only. */
export interface UserDirectoryEntry {
  id: string;
  email: string;
  role: Role;
}

export interface MeResponse {
  user: UserDTO | null;
  /** Local password sign-in works in both modes; `oidc` only adds the issuer's button. */
  authMode: 'oidc' | 'local';
  oidcConfigured: boolean;
  /** The issuer's host, for the sign-in button label; null without OIDC. */
  oidcIssuer: string | null;
  evaluation: boolean;
  /**
   * This session signed in with a temporary password: every route except `GET /auth/me`,
   * `POST /auth/password` and `POST /auth/logout` answers 403 `password_change_required`.
   */
  mustChangePassword: boolean;
  /**
   * Evaluation mode only: the bootstrap admin's email, for the sign-in page's recovery hint. Null
   * otherwise or when that account has no password; no other email is ever shown.
   */
  evaluationAdminEmail: string | null;
  /** When false the server accepts a change without a reason. */
  requireReasons: boolean;
}

export interface WhoAmIResponse {
  actor: string;
}

export interface LocalLoginRequest {
  email: string;
  password: string;
}

export const localLoginBody = bodySchema<LocalLoginRequest>()({
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', maxLength: 320 },
    // Longer than any password the policy accepts; bounds the scrypt input.
    password: { type: 'string', maxLength: PASSWORD_MAX_LENGTH * 4 },
  },
});

/** POST /auth/password: the signed-in user changes their own password. */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export const changePasswordBody = bodySchema<ChangePasswordRequest>()({
  type: 'object',
  required: ['currentPassword', 'newPassword'],
  properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string' } },
});

/** PUT /users/:id/password: an admin sets or resets a user's password (a temporary password). */
export interface SetPasswordRequest extends Reasoned {
  password: string;
}

export const setPasswordBody = bodySchema<SetPasswordRequest>()({
  type: 'object',
  required: ['reason', 'password'],
  properties: { reason: { type: 'string' }, password: { type: 'string' } },
});

export interface CreateUserRequest extends Reasoned {
  email: string;
  role: Role;
  /** Optional temporary password; the user must change it at first sign-in. */
  password?: string;
}

export const createUserBody = bodySchema<CreateUserRequest>()({
  type: 'object',
  required: ['reason', 'email', 'role'],
  properties: {
    reason: { type: 'string' },
    email: { type: 'string', maxLength: 320 },
    role: { type: 'string', enum: ROLES },
    password: { type: 'string' },
  },
});

export interface UpdateUserRequest extends Reasoned {
  role: Role;
}

export const updateUserBody = bodySchema<UpdateUserRequest>()({
  type: 'object',
  required: ['reason', 'role'],
  properties: { reason: { type: 'string' }, role: { type: 'string', enum: ROLES } },
});

export interface ApiTokenDTO {
  id: string;
  name: string;
  role: Role;
  createdAt: Iso;
  lastUsedAt: Iso | null;
  revokedAt: Iso | null;
}

export interface CreateApiTokenRequest extends Reasoned {
  /** Blank or missing: `token`. */
  name?: string;
  role: Role;
}

export const createApiTokenBody = bodySchema<CreateApiTokenRequest>()({
  type: 'object',
  required: ['reason', 'role'],
  properties: {
    reason: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', enum: ROLES },
  },
});

export interface CreateApiTokenResponse {
  token: ApiTokenDTO;
  /** Shown once. */
  secret: string;
}
