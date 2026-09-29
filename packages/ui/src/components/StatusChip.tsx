import type { StatusTone } from '@ai-switchboard/core/contract';
import type { CSSProperties } from 'react';

import { cx } from '../lib/cx.js';
import { toneVars } from '../lib/tone.js';
import styles from './StatusChip.module.css';

export interface StatusChipProps {
  tone: StatusTone;
  /** Required: colour is never shown without a word. */
  label: string;
  count?: number;
  size?: 'sm' | 'md';
  className?: string;
  /** Pass the full label when it may be clipped (the chip never outgrows its box). */
  title?: string;
}

export function StatusChip({ tone, label, count, size = 'md', className, title }: StatusChipProps) {
  const v = toneVars(tone);
  const style = { '--chip-bg': v.bg, '--chip-fg': v.fg, '--chip-dot': v.fill } as CSSProperties;
  return (
    <span
      className={cx(styles.chip, size === 'sm' && styles.sm, className)}
      style={style}
      data-tone={tone}
      title={title}
    >
      <span className={styles.dot} aria-hidden="true" />
      {count != null && <span className={styles.count}>{count}</span>}
      {label}
    </span>
  );
}
