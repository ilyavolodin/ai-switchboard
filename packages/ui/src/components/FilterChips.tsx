import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import styles from './FilterChips.module.css';
import { Icon } from './Icon.js';

export interface FilterChip {
  value: string;
  label: ReactNode;
  count?: number;
}

export interface FilterChipsProps {
  chips: FilterChip[];
  selected: string[];
  onToggle: (value: string) => void;
  label: string;
  removable?: boolean;
}

export function FilterChips({ chips, selected, onToggle, label, removable }: FilterChipsProps) {
  return (
    <div role="group" aria-label={label} className={styles.row}>
      {chips.map((c) => {
        const on = selected.includes(c.value);
        return (
          <button
            key={c.value}
            type="button"
            aria-pressed={on}
            className={cx(styles.chip, on && styles.on)}
            onClick={() => {
              onToggle(c.value);
            }}
          >
            {c.label}
            {c.count != null && <span className={styles.count}>{c.count}</span>}
            {removable && on && (
              <span className={styles.remove} aria-hidden="true">
                <Icon name="close" size={12} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
