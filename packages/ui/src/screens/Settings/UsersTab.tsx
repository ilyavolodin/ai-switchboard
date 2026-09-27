import type { Role, UserDTO } from '@ai-switchboard/core/contract';
import { type SubmitEvent, useState } from 'react';

import { errorMessage } from '../../api/client.js';
import {
  useCreateUser,
  useDeleteUser,
  useRevokeUserSessions,
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
import { Table, type TableColumn } from '../../components/Table.js';
import { TextField } from '../../components/TextField.js';
import { Time } from '../../components/Time.js';
import { Tooltip } from '../../components/Tooltip.js';
import { useReasonedMutation } from '../../hooks/reason.js';
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
  const { user: me } = useSession();
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
    </div>
  );
}

function AddUser() {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [error, setError] = useState<string | null>(null);
  const create = useReasonedMutation(
    useCreateUser(),
    (v) => ({
      title: `Add ${v.email} as ${roleLabel(v.role)}?`,
      consequence: 'They can sign in with the configured issuer from now on.',
      confirmLabel: 'Add user',
    }),
    { successMessage: 'User added' },
  );
  const onSubmit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError('Enter an email address');
      return;
    }
    setError(null);
    const res = await create.run({ email: value, role });
    if (res) setEmail('');
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
