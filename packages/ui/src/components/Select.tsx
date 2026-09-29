import type { Ref, SelectHTMLAttributes } from 'react';

import { cx } from '../lib/cx.js';
import styles from './controls.module.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options: SelectOption[];
  /** Label of an empty first option. */
  placeholder?: string;
  size?: 'sm' | 'md';
  invalid?: boolean;
  changed?: boolean;
  ref?: Ref<HTMLSelectElement>;
}

export function Select({
  options,
  placeholder,
  size = 'md',
  invalid,
  changed,
  className,
  ref,
  ...rest
}: SelectProps) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid ? true : undefined}
      className={cx(
        styles.input,
        styles.select,
        size === 'sm' && styles.sm,
        changed && styles.changed,
        invalid && styles.invalid,
        className,
      )}
      {...rest}
    >
      {placeholder != null && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
