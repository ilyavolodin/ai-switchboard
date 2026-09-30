import type { Role } from '@ai-switchboard/core/contract';

import { roleLabel } from '../../app/session.js';
import type { ReasonPromptOptions } from '../../hooks/reason.js';

export function changeRolePrompt(email: string, role: Role): ReasonPromptOptions {
  return {
    title: `Make ${email} ${roleLabel(role)}?`,
    consequence: `${roleLabel(role)} role takes effect on their next request.`,
    confirmLabel: 'Change role',
  };
}

export function removeUserPrompt(email: string): ReasonPromptOptions {
  return {
    title: `Remove ${email}?`,
    consequence: 'They are signed out everywhere and can no longer sign in.',
    confirmLabel: 'Remove user',
    danger: true,
  };
}

export function revokeSessionsPrompt(email: string): ReasonPromptOptions {
  return {
    title: `Sign ${email} out everywhere?`,
    consequence: 'Every session they have ends now; they can sign in again.',
    confirmLabel: 'Revoke sessions',
    danger: true,
  };
}

export function setPasswordPrompt(email: string): ReasonPromptOptions {
  return {
    title: `Set a temporary password for ${email}?`,
    consequence:
      'Every session they have ends now, and they must choose their own password at the next sign-in.',
    confirmLabel: 'Set password',
    danger: true,
  };
}

export function removePasswordPrompt(email: string): ReasonPromptOptions {
  return {
    title: `Remove the password for ${email}?`,
    consequence: 'They are signed out everywhere and can sign in only through OIDC from now on.',
    confirmLabel: 'Remove password',
    danger: true,
  };
}

export function addUserPrompt(
  user: { email: string; role: Role; password?: string },
  oidcConfigured: boolean,
): ReasonPromptOptions {
  return {
    title: `Add ${user.email} as ${roleLabel(user.role)}?`,
    consequence:
      user.password !== undefined
        ? 'They sign in with the temporary password and must choose their own at the first sign-in.'
        : oidcConfigured
          ? 'They can sign in with the configured issuer from now on.'
          : 'They cannot sign in until you set a password (or configure OIDC).',
    confirmLabel: 'Add user',
  };
}

export function createTokenPrompt(name: string | undefined, role: Role): ReasonPromptOptions {
  return {
    title: `Create the token “${name ?? 'token'}”?`,
    consequence: `It can do anything the ${roleLabel(role)} role can until you revoke it.`,
    confirmLabel: 'Create token',
  };
}

export function revokeTokenPrompt(name: string | undefined): ReasonPromptOptions {
  return {
    title: `Revoke “${name ?? 'this token'}”?`,
    consequence: 'Anything using it (the CLI, a CI pipeline) gets 401 from its next request.',
    confirmLabel: 'Revoke token',
    danger: true,
  };
}
