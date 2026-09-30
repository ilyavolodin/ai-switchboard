import type { StatusTone } from '@ai-switchboard/core/contract';

import { cx } from '../lib/cx.js';
import styles from './ToneDot.module.css';

/** A decorative dot in a status tone; always next to words that say the same. */
export function ToneDot({
  tone,
  size = 6,
  className,
}: {
  tone: StatusTone | 'info';
  size?: 6 | 8;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      className={cx(styles.dot, size === 8 && styles.large, className)}
    />
  );
}
