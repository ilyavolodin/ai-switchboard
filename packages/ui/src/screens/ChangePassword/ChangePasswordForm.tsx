import type { MeResponse } from '@ai-switchboard/core/contract';
import { type SubmitEvent, useState } from 'react';

import { errorMessage } from '../../api/client.js';
import { useChangePassword } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { Icon } from '../../components/Icon.js';
import { TextField } from '../../components/TextField.js';
import styles from './ChangePassword.module.css';
import { passwordError, passwordRules } from '../shared/passwordRules.js';

export interface ChangePasswordFormProps {
  email: string;
  onChanged: (me: MeResponse) => void;
  submitLabel?: string;
}

export function ChangePasswordForm({
  email,
  onChanged,
  submitLabel = 'Change password',
}: ChangePasswordFormProps) {
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const found: typeof errors = {};
    if (current === '') found.current = 'Enter your current password.';
    const problem = passwordError(next, email);
    if (problem) found.next = problem;
    else if (next === current) found.next = 'Choose a password different from the current one.';
    if (confirm !== next) found.confirm = 'The passwords do not match.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: (me) => {
          onChanged(me);
        },
      },
    );
  };

  const rules = passwordRules(next, email);
  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {/* Lets password managers attach the new password to the right account. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <Field label="Current password" required error={errors.current ?? null}>
        {({ id, describedBy, invalid }) => (
          <TextField
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
            }}
          />
        )}
      </Field>
      <Field label="New password" required error={errors.next ?? null}>
        {({ id, describedBy, invalid }) => (
          <TextField
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
            }}
          />
        )}
      </Field>
      <ul className={styles.rules} aria-label="Password rules">
        {rules.map((r) => (
          <li key={r.label} className={r.met ? styles.met : undefined}>
            <Icon name={r.met ? 'check' : 'close'} size={12} />
            {r.label}
            <span className="visually-hidden">{r.met ? ' (met)' : ' (not met)'}</span>
          </li>
        ))}
      </ul>
      <Field label="Confirm new password" required error={errors.confirm ?? null}>
        {({ id, describedBy, invalid }) => (
          <TextField
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
            }}
          />
        )}
      </Field>
      {change.error && <Banner tone="error">{errorMessage(change.error)}</Banner>}
      <Button type="submit" variant="primary" block loading={change.isPending}>
        {submitLabel}
      </Button>
    </form>
  );
}
