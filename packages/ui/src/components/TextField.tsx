import type { InputHTMLAttributes, ReactNode, Ref } from 'react';

import { cx } from '../lib/cx.js';
import styles from './controls.module.css';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md';
  mono?: boolean;
  invalid?: boolean;
  /** Tangerine border until saved. */
  changed?: boolean;
  /** Unit after the input ("seconds", "minutes"). */
  suffix?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

/** A single-line input on the sunken input ground. Use inside `<Field>` for a label. */
export function TextField({
  size = 'md',
  mono,
  invalid,
  changed,
  suffix,
  className,
  ref,
  ...rest
}: TextFieldProps) {
  const input = (
    <input
      ref={ref}
      aria-invalid={invalid ? true : undefined}
      className={cx(
        styles.input,
        size === 'sm' && styles.sm,
        mono && styles.mono,
        changed && styles.changed,
        invalid && styles.invalid,
        className,
      )}
      {...rest}
    />
  );
  if (suffix == null) return input;
  return (
    <span className={styles.withAffix}>
      {input}
      <span className={styles.affix}>{suffix}</span>
    </span>
  );
}
