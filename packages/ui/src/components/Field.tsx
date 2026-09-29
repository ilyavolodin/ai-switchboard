import { type ReactNode, useId } from 'react';

import { cx } from '../lib/cx.js';
import styles from './Field.module.css';
import { Icon } from './Icon.js';

export interface FieldIds {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

export interface FieldProps {
  label: ReactNode;
  help?: ReactNode;
  error?: string | null;
  /** A standing warning about the current value, not a validation error. */
  warning?: string | null;
  required?: boolean;
  changed?: boolean;
  disabled?: boolean;
  layout?: 'stack' | 'row';
  aside?: ReactNode;
  children: (ids: FieldIds) => ReactNode;
  className?: string;
}

export function Field({
  label,
  help,
  error,
  warning,
  required,
  changed,
  disabled,
  layout = 'stack',
  aside,
  children,
  className,
}: FieldProps) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const warningId = warning ? `${id}-warning` : undefined;
  const describedBy = [errorId, warningId, helpId].filter(Boolean).join(' ') || undefined;
  return (
    <div
      className={cx(
        styles.field,
        layout === 'row' && styles.row,
        disabled && styles.disabled,
        className,
      )}
    >
      <div className={styles.labelWrap}>
        <label htmlFor={id} className={styles.label}>
          {label}
          {required && (
            <span className={styles.required} aria-hidden="true">
              {' '}
              *
            </span>
          )}
          {required && <span className="visually-hidden"> (required)</span>}
        </label>
        {changed && <span className={styles.changedDot} title="changed, not saved" />}
        {aside}
      </div>
      <div className={styles.control}>
        {children({ id, describedBy, invalid: Boolean(error) })}
        {error && (
          <span id={errorId} className={styles.error} role="alert">
            <Icon name="warning" size={13} />
            {error}
          </span>
        )}
        {warning && (
          <span id={warningId} className={styles.warning} role="note">
            <Icon name="warning" size={13} />
            {warning}
          </span>
        )}
        {help && (
          <span id={helpId} className={styles.help}>
            {help}
          </span>
        )}
      </div>
    </div>
  );
}
