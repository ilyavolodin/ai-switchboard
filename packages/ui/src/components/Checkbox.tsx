import type { InputHTMLAttributes, ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  variant?: 'plain' | 'pill';
  hint?: ReactNode;
}

export function Checkbox({
  label,
  variant = 'plain',
  hint,
  className,
  checked,
  disabled,
  ...rest
}: CheckboxProps) {
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
      <input type="checkbox" checked={checked} disabled={disabled} {...rest} />
      <span>{label}</span>
      {hint != null && <span className={styles.hint}>{hint}</span>}
    </label>
  );
}
