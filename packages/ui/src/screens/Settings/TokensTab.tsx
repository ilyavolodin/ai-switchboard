import type { ApiTokenDTO, CreateApiTokenResponse, Role } from '@ai-switchboard/core/contract';
import { type SubmitEvent, useState } from 'react';

import { errorMessage } from '../../api/client.js';
import { useCreateToken, useDeleteToken, useTokens } from '../../api/index.js';
import { roleLabel, useSession } from '../../app/session.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Table, type TableColumn } from '../../components/Table.js';
import { TextField } from '../../components/TextField.js';
import { Time } from '../../components/Time.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { useToast } from '../../hooks/toast.js';
import styles from './Settings.module.css';
import { grantableRoles } from './settingsForm.js';

/**
 * API tokens: personal tokens for the CLI and CI, each scoped to a role no higher than the
 * owner's. The secret is shown once, right after creation, and never again.
 */
export function TokensTab() {
  const tokens = useTokens();
  const [created, setCreated] = useState<CreateApiTokenResponse | null>(null);
  const revoke = useReasonedMutation(
    useDeleteToken(),
    (v) => ({
      title: `Revoke “${tokens.data?.find((t) => t.id === v.id)?.name ?? 'this token'}”?`,
      consequence: 'Anything using it (the CLI, a CI job) gets 401 from its next request.',
      confirmLabel: 'Revoke token',
      danger: true,
    }),
    { successMessage: 'Token revoked' },
  );

  const columns: TableColumn<ApiTokenDTO>[] = [
    { key: 'name', header: 'name', cell: (t) => <span className={styles.itemName}>{t.name}</span> },
    { key: 'role', header: 'role', cell: (t) => roleLabel(t.role) },
    { key: 'created', header: 'created', cell: (t) => <Time value={t.createdAt} /> },
    {
      key: 'used',
      header: 'last used',
      cell: (t) => <Time value={t.lastUsedAt} fallback="never" />,
    },
    {
      key: 'status',
      header: 'status',
      cell: (t) =>
        t.revokedAt ? (
          <StatusChip size="sm" tone="off" label="revoked" />
        ) : (
          <StatusChip size="sm" tone="ok" label="active" />
        ),
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">actions</span>,
      align: 'right',
      cell: (t) =>
        t.revokedAt ? null : (
          <Button
            size="sm"
            variant="danger-outline"
            aria-label={`Revoke ${t.name}`}
            onClick={() => void revoke.run({ id: t.id })}
          >
            Revoke
          </Button>
        ),
    },
  ];

  return (
    <div className={styles.stack}>
      <CreateToken onCreated={setCreated} />
      <Card title="Your API tokens" subtitle="send as Authorization: Bearer <token>">
        {tokens.isPending ? (
          <Skeleton lines={3} height={24} label="Loading tokens" />
        ) : tokens.isError ? (
          <Banner tone="error" title="Tokens could not load">
            {errorMessage(tokens.error)}
          </Banner>
        ) : (
          <Table
            caption="API tokens"
            columns={columns}
            rows={tokens.data}
            rowKey={(t) => t.id}
            empty="No tokens yet. Create one for the CLI or a CI job that applies configuration."
          />
        )}
      </Card>
      <SecretDialog
        created={created}
        onClose={() => {
          setCreated(null);
        }}
      />
    </div>
  );
}

function CreateToken({ onCreated }: { onCreated: (res: CreateApiTokenResponse) => void }) {
  const { user } = useSession();
  const roles = grantableRoles(user?.role ?? 'viewer');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [error, setError] = useState<string | null>(null);
  const create = useReasonedMutation(useCreateToken(), (v) => ({
    title: `Create the token “${v.name}”?`,
    consequence: `It can do anything the ${roleLabel(v.role)} role can until you revoke it.`,
    confirmLabel: 'Create token',
  }));
  const onSubmit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name the token after what uses it');
      return;
    }
    setError(null);
    const res = await create.run({ name: name.trim(), role });
    if (res) {
      setName('');
      onCreated(res);
    }
  };
  return (
    <Card title="Create a token">
      <form className={styles.inline} onSubmit={(e) => void onSubmit(e)} noValidate>
        <Field label="Name" error={error} className={styles.grow}>
          {({ id, describedBy, invalid }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              placeholder="CI apply"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Role">
          {({ id }) => (
            <Select
              id={id}
              value={role}
              options={roles.map((r) => ({ value: r, label: roleLabel(r) }))}
              onChange={(e) => {
                const next = roles.find((r) => r === e.target.value);
                if (next) setRole(next);
              }}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" icon="key" loading={create.pending}>
          Create token
        </Button>
      </form>
      <p className={styles.hint}>A token can have your role or a lower one.</p>
    </Card>
  );
}

function SecretDialog({
  created,
  onClose,
}: {
  created: CreateApiTokenResponse | null;
  onClose: () => void;
}) {
  const toast = useToast();
  return (
    <Dialog
      open={created != null}
      onClose={onClose}
      dismissible={false}
      title="Copy your token now"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {created && (
        <div className={styles.fields}>
          <p className={styles.hint}>
            This is the only time the secret for “{created.token.name}” is shown. Store it in your
            CI secrets or password manager; if you lose it, revoke the token and create another.
          </p>
          <div className={styles.secret}>
            <code className={styles.secretValue} aria-label="Token secret">
              {created.secret}
            </code>
            <Button
              variant="outline"
              icon="copy"
              onClick={() => {
                void navigator.clipboard.writeText(created.secret).then(() => {
                  toast({ tone: 'ok', title: 'Token copied' });
                });
              }}
            >
              Copy
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
