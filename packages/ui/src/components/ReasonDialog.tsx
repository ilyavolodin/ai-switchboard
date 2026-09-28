import { type SubmitEvent, type ReactNode, useState } from 'react';

import { Button } from './Button.js';
import { Dialog } from './Dialog.js';
import { Field } from './Field.js';
import styles from './ReasonDialog.module.css';
import { TextField } from './TextField.js';

export interface ReasonDialogProps {
  open: boolean;
  /** "Reset the Autofix breaker?" */
  title: ReactNode;
  /** The sentence naming the consequence. */
  consequence?: ReactNode;
  /** The confirm button repeats the verb ("Reset breaker"). */
  confirmLabel: string;
  danger?: boolean;
  placeholder?: string;
  /** Reasons are optional on this installation: ask for an optional note, allow a blank one. */
  optional?: boolean;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/**
 * Asks for the one-line reason every state-changing action carries (it becomes the audit
 * entry). Confirm is refused until a non-blank reason is typed, unless `optional` (the
 * installation does not require reasons), when the field is an optional note. Prefer
 * `useReasonedMutation`, which opens this through `<ReasonProvider>`.
 */
export function ReasonDialog({
  open,
  title,
  consequence,
  confirmLabel,
  danger,
  placeholder = 'e.g. investigating repeated test timeouts',
  optional = false,
  busy,
  onConfirm,
  onCancel,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed && !optional) {
      setError('A reason is required — it becomes the audit entry.');
      return;
    }
    onConfirm(trimmed);
    setReason('');
    setError(null);
  };

  const cancel = () => {
    setReason('');
    setError(null);
    onCancel();
  };

  return (
    <Dialog open={open} onClose={cancel} title={title}>
      <form className={styles.form} onSubmit={submit} noValidate>
        {consequence != null && <p className={styles.consequence}>{consequence}</p>}
        <Field
          label={optional ? 'Note (optional)' : 'Reason'}
          required={!optional}
          error={error}
          help={
            optional
              ? 'One line for the audit log. Leave it blank to record “(no reason given)”.'
              : 'One line. It is recorded in the audit log.'
          }
        >
          {({ id, describedBy, invalid }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              required={!optional}
              autoComplete="off"
              maxLength={500}
              placeholder={placeholder}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error && e.target.value.trim()) setError(null);
              }}
            />
          )}
        </Field>
        <div className={styles.actions}>
          <Button variant="outline" onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
