import type { InputHTMLAttributes, Ref } from 'react';

import { cx } from '../lib/cx.js';
import { Icon } from './Icon.js';
import styles from './SearchInput.module.css';

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Accessible name; there is no visible label. */
  label: string;
  shortcut?: string;
  mono?: boolean;
  ref?: Ref<HTMLInputElement>;
  className?: string;
}

export function SearchInput({ label, shortcut, mono, className, ref, ...rest }: SearchInputProps) {
  return (
    <label className={cx(styles.box, className)}>
      <Icon name="search" size={14} />
      <input
        ref={ref}
        type="search"
        aria-label={label}
        className={cx(styles.input, mono && styles.mono)}
        {...rest}
      />
      {shortcut && (
        <kbd className={styles.kbd} aria-hidden="true">
          {shortcut}
        </kbd>
      )}
    </label>
  );
}
