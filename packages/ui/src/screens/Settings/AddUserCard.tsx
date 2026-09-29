import type { Role } from '@ai-switchboard/core/contract';
import { type SubmitEvent, useState } from 'react';

import { useCreateUser } from '../../api/index.js';
import { roleLabel, useCan, useSession } from '../../app/session.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { TextField } from '../../components/TextField.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import styles from './Settings.module.css';
import { checkNewUser } from './settingsForm.js';
import { isRole, ROLE_OPTIONS } from './userColumns.js';

export function AddUserCard() {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [passwordErr, setPasswordErr] = useState<string | null>(null);
  const { oidcConfigured } = useSession();
  const isAdmin = useCan('admin');
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
    const check = checkNewUser(email, password);
    setError(check.emailError);
    setPasswordErr(check.passwordError);
    if (check.emailError || check.passwordError) return;
    const res = await create.run({
      email: check.email,
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
              disabled={!isAdmin}
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
              disabled={!isAdmin}
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
              disabled={!isAdmin}
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
