import {
  useDeleteUser,
  useRemoveUserPassword,
  useRevokeUserSessions,
  useSetUserPassword,
  useUpdateUser,
} from '../../api/index.js';
import { roleLabel } from '../../app/session.js';
import { useReasonedMutation } from '../../hooks/reason.js';

export function useUserActions(emailOf: (id: string) => string) {
  const updateRole = useReasonedMutation(
    useUpdateUser(),
    (v) => ({
      title: `Make ${emailOf(v.id)} ${roleLabel(v.role)}?`,
      consequence: `${roleLabel(v.role)} role takes effect on their next request.`,
      confirmLabel: 'Change role',
    }),
    { successMessage: 'Role changed' },
  );
  const remove = useReasonedMutation(
    useDeleteUser(),
    (v) => ({
      title: `Remove ${emailOf(v.id)}?`,
      consequence: 'They are signed out everywhere and can no longer sign in.',
      confirmLabel: 'Remove user',
      danger: true,
    }),
    { successMessage: 'User removed' },
  );
  const revoke = useReasonedMutation(
    useRevokeUserSessions(),
    (v) => ({
      title: `Sign ${emailOf(v.id)} out everywhere?`,
      consequence: 'Every session they have ends now; they can sign in again.',
      confirmLabel: 'Revoke sessions',
      danger: true,
    }),
    { successMessage: 'Sessions revoked' },
  );
  const setPassword = useReasonedMutation(
    useSetUserPassword(),
    (v) => ({
      title: `Set a temporary password for ${emailOf(v.id)}?`,
      consequence:
        'Every session they have ends now, and they must choose their own password at the next sign-in.',
      confirmLabel: 'Set password',
      danger: true,
    }),
    { successMessage: 'Temporary password set — pass it on securely' },
  );
  const removePassword = useReasonedMutation(
    useRemoveUserPassword(),
    (v) => ({
      title: `Remove the password for ${emailOf(v.id)}?`,
      consequence: 'They are signed out everywhere and can sign in only through OIDC from now on.',
      confirmLabel: 'Remove password',
      danger: true,
    }),
    { successMessage: 'Password removed' },
  );
  return { updateRole, remove, revoke, setPassword, removePassword };
}
