import { type ReactNode, useId } from 'react';

import { cx } from '../lib/cx.js';
import styles from './Field.module.css';
import { Icon } from './Icon.js';

/** The ids a control inside a `Field` must use (from the render prop). */
export interface FieldIds {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

export interface FieldProps {
  label: ReactNode;
  /** Short help under the control; long help can be a node. */
  help?: ReactNode;
  error?: string | null;
  required?: boolean;
  /** Shows the tangerine "changed, not saved" dot. */
  changed?: boolean;
  disabled?: boolean;
  /** `row` puts the label left of the control (settings grids); `stack` above it. */
  layout?: 'stack' | 'row';
  /** Extra content right of the label (a Reset link, a default value). */
  aside?: ReactNode;
  /** A render prop receiving the ids to wire (`id`, `aria-describedby`, `aria-invalid`). */
  children: (ids: FieldIds) => ReactNode;
  className?: string;
}

/**
 * A labelled form row: label (with required marker and changed dot), the control, help and an
 * error message. The control is rendered by a function so ids and descriptions are wired for it.
 */
export function Field({
  label,
  help,
  error,
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
  const describedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined;
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
        {help && (
          <span id={helpId} className={styles.help}>
            {help}
          </span>
        )}
      </div>
    </div>
  );
}
