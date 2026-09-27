import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import styles from './SegmentedControl.module.css';

/** One segment. */
export interface Segment<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

export interface SegmentedControlProps<T extends string> {
  options: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  /** `window` is the mono tangerine-soft picker for 24 h / 7 d / 30 d. */
  variant?: 'default' | 'window';
}

/**
 * A single-choice segmented control (a radio group of buttons): the "All · Healthy · Attention"
 * filter and the 24 h / 7 d / 30 d window picker.
 */
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
