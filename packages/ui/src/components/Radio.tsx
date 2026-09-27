import type { InputHTMLAttributes, ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import styles from './Checkbox.module.css';

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  variant?: 'plain' | 'pill';
}

/** A labelled radio button; group several with the same `name` inside a `<fieldset>`. */
export function Radio({
  label,
  variant = 'plain',
  className,
  checked,
  disabled,
  ...rest
}: RadioProps) {
  return (
    <label
      className={cx(
        styles.choice,
        variant === 'pill' && styles.pill,
        checked && styles.checked,
        disabled && styles.disabled,
        className,
      )}
    >
      <input type="radio" checked={checked} disabled={disabled} {...rest} />
      <span>{label}</span>
    </label>
  );
}
