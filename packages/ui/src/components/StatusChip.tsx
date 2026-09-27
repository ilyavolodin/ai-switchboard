import type { StatusTone } from '@ai-switchboard/core/contract';
import type { CSSProperties } from 'react';

import { cx } from '../lib/cx.js';
import { toneVars } from '../lib/tone.js';
import styles from './StatusChip.module.css';

export interface StatusChipProps {
  /** One of the four tones: ok (mint), warn (amber), error (coral), off (grey). */
  tone: StatusTone;
  /** The word. Required: colour is never shown without one. */
  label: string;
  /** A count shown in mono before the label ("1 breaker open"). */
  count?: number;
  /** `sm` (20 px) in tables and the top bar; `md` (22 px) in headers. */
  size?: 'sm' | 'md';
  className?: string;
  /** Hover text; pass the full label when it may be clipped (the chip never outgrows its box). */
  title?: string;
}

/** The status vocabulary: a tinted pill with a dot and a word. */
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
