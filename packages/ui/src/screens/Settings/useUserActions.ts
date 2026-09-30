import {
  useDeleteUser,
  useRemoveUserPassword,
  useRevokeUserSessions,
  useSetUserPassword,
  useUpdateUser,
} from '../../api/index.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import {
  changeRolePrompt,
  removePasswordPrompt,
  removeUserPrompt,
  revokeSessionsPrompt,
  setPasswordPrompt,
} from './userPrompts.js';

export function useUserActions(emailOf: (id: string) => string) {
  const updateRole = useReasonedMutation(
    useUpdateUser(),
    (v) => changeRolePrompt(emailOf(v.id), v.role),
    { successMessage: 'Role changed' },
  );
  const remove = useReasonedMutation(useDeleteUser(), (v) => removeUserPrompt(emailOf(v.id)), {
    successMessage: 'User removed',
  });
  const revoke = useReasonedMutation(
    useRevokeUserSessions(),
    (v) => revokeSessionsPrompt(emailOf(v.id)),
    { successMessage: 'Sessions revoked' },
  );
  const setPassword = useReasonedMutation(
    useSetUserPassword(),
    (v) => setPasswordPrompt(emailOf(v.id)),
    { successMessage: 'Temporary password set — pass it on securely' },
  );
  const removePassword = useReasonedMutation(
    useRemoveUserPassword(),
    (v) => removePasswordPrompt(emailOf(v.id)),
    { successMessage: 'Password removed' },
  );
  return { updateRole, remove, revoke, setPassword, removePassword };
}
