import type { CreateApiTokenResponse, Role } from '@ai-switchboard/core/contract';
import { type SubmitEvent, useState } from 'react';

import { useCreateToken, useDeleteToken, useTokens } from '../../api/index.js';
import { useSession } from '../../app/session.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { CopyButton } from '../../components/CopyButton.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { QueryBoundary } from '../../components/QueryBoundary.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Table } from '../../components/Table.js';
import { TextField } from '../../components/TextField.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import styles from './Settings.module.css';
import { tokenColumns } from './tokenColumns.js';
import { createTokenPrompt, revokeTokenPrompt } from './userPrompts.js';
import { grantableRoles, roleOptions } from './users.js';

export function TokensTab() {
  const tokens = useTokens();
  const [created, setCreated] = useState<CreateApiTokenResponse | null>(null);
  const revoke = useReasonedMutation(
    useDeleteToken(),
    (v) => revokeTokenPrompt(tokens.data?.find((t) => t.id === v.id)?.name),
    { successMessage: 'Token revoked' },
  );
  const columns = tokenColumns((t) => void revoke.run({ id: t.id }));

  return (
    <div className={styles.stack}>
      <CreateToken onCreated={setCreated} />
      <Card title="Your API tokens" subtitle="send as Authorization: Bearer <token>">
        <QueryBoundary
          query={tokens}
          errorTitle="Tokens could not load"
          pending={<Skeleton lines={3} height={24} label="Loading tokens" />}
        >
          {(rows) => (
            <Table
              caption="API tokens"
              columns={columns}
              rows={rows}
              rowKey={(t) => t.id}
              empty="No tokens yet. Create one for the CLI or a CI pipeline that applies configuration."
            />
          )}
        </QueryBoundary>
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
  const create = useReasonedMutation(useCreateToken(), (v) => createTokenPrompt(v.name, v.role));
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
              options={roleOptions(roles)}
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
            <CopyButton text value={created.secret} label="Copy" copiedMessage="Token copied" />
          </div>
        </div>
      )}
    </Dialog>
  );
}
