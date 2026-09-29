import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import styles from './SegmentedControl.module.css';

export interface Segment<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

export interface SegmentedControlProps<T extends string> {
  options: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  variant?: 'default' | 'window';
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  variant = 'default',
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(styles.track, variant === 'window' && styles.window)}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={cx(styles.option, selected && styles.selected)}
            onClick={() => {
              onChange(o.value);
            }}
          >
            {o.label}
            {o.count != null && <span className={styles.count}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
