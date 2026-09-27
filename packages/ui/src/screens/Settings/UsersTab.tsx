import type { Role, UserDTO } from '@ai-switchboard/core/contract';
import { type SubmitEvent, useState } from 'react';

import { errorMessage } from '../../api/client.js';
import {
  useCreateUser,
  useDeleteUser,
  useRemoveUserPassword,
  useRevokeUserSessions,
  useSetUserPassword,
  useUpdateUser,
  useUsers,
} from '../../api/index.js';
import { roleLabel, useCan, useSession } from '../../app/session.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Table, type TableColumn } from '../../components/Table.js';
import { TextField } from '../../components/TextField.js';
import { Time } from '../../components/Time.js';
import { Tooltip } from '../../components/Tooltip.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { passwordError } from '../ChangePassword/passwordRules.js';
import { SetPasswordDialog } from './SetPasswordDialog.js';
import styles from './Settings.module.css';
import { initials } from './settingsForm.js';

const ROLE_OPTIONS = (['admin', 'operator', 'viewer'] as const).map((r) => ({
  value: r,
  label: roleLabel(r),
}));

const isRole = (v: string): v is Role => v === 'admin' || v === 'operator' || v === 'viewer';

/** Users: who can sign in and with which role. Admin only (the API refuses everyone else). */
export function UsersTab() {
  const isAdmin = useCan('admin');
  const { user } = useSession();
  if (!isAdmin) {
    return (
      <Card title="Users">
        <EmptyState title="Users are managed by admins">
          You are signed in as {user?.email ?? 'a guest'} with the{' '}
          {user ? roleLabel(user.role) : 'no'} role. Ask an admin to add people or change roles.
        </EmptyState>
      </Card>
    );
  }
  return <UsersAdmin />;
}

function UsersAdmin() {
  const users = useUsers();
  const { user: me, oidcConfigured } = useSession();
  const [passwordFor, setPasswordFor] = useState<UserDTO | null>(null);
  const emailOf = (id: string): string =>
    users.data?.find((u) => u.id === id)?.email ?? 'this user';
  const update = useReasonedMutation(
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

  const columns: TableColumn<UserDTO>[] = [
    {
      key: 'email',
      header: 'email',
      cell: (u) => (
        <span className={styles.who}>
          <span className={styles.avatar} aria-hidden="true">
            {initials(u.email)}
          </span>
          {u.email}
          {u.id === me?.id && <span className={styles.muted}>· you</span>}
        </span>
      ),
    },
    {
      key: 'role',
      header: 'role',
      width: 140,
      cell: (u) => {
        const self = u.id === me?.id;
        const select = (
          <Select
            size="sm"
            aria-label={`Role for ${u.email}`}
            value={u.role}
            options={ROLE_OPTIONS}
            disabled={self}
            onChange={(e) => {
              const role = e.target.value;
              if (isRole(role) && role !== u.role) void update.run({ id: u.id, role });
            }}
          />
        );
        return self ? <Tooltip content="You can’t change your own role">{select}</Tooltip> : select;
      },
    },
    {
      key: 'signIn',
      header: 'sign-in',
      cell: (u) => (
        <span className={styles.rowActions}>
          {u.hasPassword && (
            <StatusChip
              size="sm"
              tone={u.mustChangePassword ? 'warn' : 'ok'}
              label={u.mustChangePassword ? 'temporary password' : 'password'}
            />
          )}
          {u.hasOidc && <StatusChip size="sm" tone="ok" label="OIDC" />}
          {!u.hasPassword && !u.hasOidc && (
            <StatusChip size="sm" tone="off" label="not yet signed in" />
          )}
        </span>
      ),
    },
    {
      key: 'last',
      header: 'last sign-in',
      cell: (u) => <Time value={u.lastLoginAt} fallback="never" />,
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">actions</span>,
      align: 'right',
      cell: (u) => {
        const self = u.id === me?.id;
        return (
          <span className={styles.rowActions}>
            <Button
              size="sm"
              variant="ghost"
              requires="admin"
              disabled={self}
              disabledReason="Change your own password from your account"
              aria-label={`${u.hasPassword ? 'Reset' : 'Set'} password for ${u.email}`}
              onClick={() => {
                setPasswordFor(u);
              }}
            >
              {u.hasPassword ? 'Reset password' : 'Set password'}
            </Button>
            {u.hasPassword && oidcConfigured && (
              <Button
                size="sm"
                variant="ghost"
                requires="admin"
                aria-label={`Remove password for ${u.email}`}
                onClick={() => void removePassword.run({ id: u.id })}
              >
                Remove password
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              requires="admin"
              aria-label={`Revoke sessions for ${u.email}`}
              onClick={() => void revoke.run({ id: u.id })}
            >
              Revoke sessions
            </Button>
            <Button
              size="sm"
              variant="danger-outline"
              requires="admin"
              disabled={self}
              disabledReason="You can’t remove yourself"
              aria-label={`Remove ${u.email}`}
              onClick={() => void remove.run({ id: u.id })}
            >
              Remove
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <div className={styles.stack}>
      <AddUser />
      <Card title="Users" subtitle="admin · operator · viewer — every change is audited">
        {users.isPending ? (
          <Skeleton lines={4} height={24} label="Loading users" />
        ) : users.isError ? (
          <Banner tone="error" title="Users could not load">
            {errorMessage(users.error)}
          </Banner>
        ) : (
          <Table caption="Users" columns={columns} rows={users.data} rowKey={(u) => u.id} />
        )}
      </Card>
      <SetPasswordDialog
        email={passwordFor?.email ?? null}
        reset={passwordFor?.hasPassword ?? false}
        onClose={() => {
          setPasswordFor(null);
        }}
        onSubmit={(password) => {
          const target = passwordFor;
          setPasswordFor(null);
          if (target) void setPassword.run({ id: target.id, password });
        }}
      />
    </div>
  );
}

function AddUser() {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [passwordErr, setPasswordErr] = useState<string | null>(null);
  const { oidcConfigured } = useSession();
  const create = useReasonedMutation(
    useCreateUser(),
    (v) => ({
      title: `Add ${v.email} as ${roleLabel(v.role)}?`,
      consequence:
        v.password !== undefined
          ? 'They sign in with the temporary password and must choose their own at the first sign-in.'
          : oidcConfigured
            ? 'They can sign in with the configured issuer from now on.'
            : 'They cannot sign in until you set a password (or configure OIDC).',
      confirmLabel: 'Add user',
    }),
    { successMessage: 'User added' },
  );
  const onSubmit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    const pwProblem = password === '' ? null : passwordError(password, value);
    setError(emailOk ? null : 'Enter an email address');
    setPasswordErr(pwProblem);
    if (!emailOk || pwProblem) return;
    const res = await create.run({
      email: value,
      role,
      ...(password !== '' ? { password } : {}),
    });
    if (res) {
      setEmail('');
      setPassword('');
    }
  };
  return (
    <Card title="Add a user">
      <form className={styles.inline} onSubmit={(e) => void onSubmit(e)} noValidate>
        <Field label="Email" error={error} className={styles.grow}>
          {({ id, describedBy, invalid }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="Temporary password"
          error={passwordErr}
          help={oidcConfigured ? 'Optional — leave empty for OIDC only' : 'Optional'}
        >
          {({ id, describedBy, invalid }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              mono
              autoComplete="off"
              spellCheck={false}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Role">
          {({ id }) => (
            <Select
              id={id}
              value={role}
              options={ROLE_OPTIONS}
              onChange={(e) => {
                if (isRole(e.target.value)) setRole(e.target.value);
              }}
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="primary"
          icon="plus"
          requires="admin"
          loading={create.pending}
        >
          Add user
        </Button>
      </form>
    </Card>
  );
}
