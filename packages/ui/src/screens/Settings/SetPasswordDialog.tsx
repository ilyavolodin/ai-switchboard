import { type SubmitEvent, useId, useState } from 'react';

import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { TextField } from '../../components/TextField.js';
import { passwordError } from '../shared/passwordRules.js';
import styles from './Settings.module.css';

export interface SetPasswordDialogProps {
  email: string | null;
  reset: boolean;
  onClose: () => void;
  onSubmit: (password: string) => void;
}

/** No look-alike characters. */
function generateTemporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = '';
  for (const b of bytes) out += alphabet.charAt(b % alphabet.length);
  return out.replace(/(.{5})(?!$)/g, '$1-');
}

/**
 * Shown in the clear so the admin can pass it on; the user must change it at their next password
 * sign-in.
 */
export function SetPasswordDialog({ email, reset, onClose, onSubmit }: SetPasswordDialogProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  const close = () => {
    setPassword('');
    setError(null);
    onClose();
  };
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const problem = passwordError(password, email ?? '');
    if (problem) {
      setError(problem);
      return;
    }
    const chosen = password;
    setPassword('');
    setError(null);
    onSubmit(chosen);
  };

  return (
    <Dialog
      open={email !== null}
      onClose={close}
      title={`${reset ? 'Reset' : 'Set'} the password for ${email ?? ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary">
            Continue
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.fields} onSubmit={submit} noValidate>
        <Field
          label="Temporary password"
          error={error}
          help="At least 8 characters. They choose their own at the next sign-in; every session they have ends now."
          aside={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPassword(generateTemporaryPassword());
                setError(null);
              }}
            >
              Generate
            </Button>
          }
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
      </form>
    </Dialog>
  );
}
