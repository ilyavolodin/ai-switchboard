import { cx } from '../lib/cx.js';
import styles from './CapacityBar.module.css';

/** A tick on the bar: a reserve, a ceiling, a projection. */
export interface CapacityMark {
  /** Position as a fraction of the limit, 0–1. */
  at: number;
  label: string;
  color?: string;
}

export interface CapacityBarProps {
  used: number;
  /** `null` = no cap: the bar is empty and the text reads "4/—". */
  limit: number | null;
  /** Accessible name: "Runs today". */
  label: string;
  marks?: CapacityMark[];
  /** Beyond the first mark the fill turns this colour (into the reserve / above ceiling). */
  overColor?: string;
  size?: 'md' | 'lg';
  /** Hide the "6/8" text. */
  hideText?: boolean;
}

/** A budget used against its cap as a thin bar with optional ticks (a process's daily cap). */
export function CapacityBar({
  used,
  limit,
  label,
  marks = [],
  overColor = 'var(--warning)',
  size = 'md',
  hideText,
}: CapacityBarProps) {
  const fraction = limit && limit > 0 ? Math.min(1, used / limit) : 0;
  const firstMark = marks.length ? Math.min(...marks.map((m) => m.at)) : null;
  const overStart = firstMark != null && fraction > firstMark ? firstMark : null;
  return (
    <span className={cx(styles.wrap, size === 'lg' && styles.lg)}>
      <span
        className={styles.track}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit ?? undefined}
        aria-valuenow={used}
        aria-valuetext={limit != null ? `${used} of ${limit}` : `${used}, no cap`}
      >
        <span className={styles.fill} style={{ width: `${(overStart ?? fraction) * 100}%` }} />
        {overStart != null && (
          <span
            className={styles.over}
            style={{
              left: `${overStart * 100}%`,
              width: `${(fraction - overStart) * 100}%`,
              background: overColor,
            }}
          />
        )}
        {marks.map((m) => (
          <span
            key={m.label}
            className={styles.mark}
            title={m.label}
            style={{
              left: `${Math.min(1, m.at) * 100}%`,
              background: m.color ?? 'var(--border-4)',
            }}
          />
        ))}
      </span>
      {!hideText && (
        <span className={styles.text}>
          {used}/{limit ?? '—'}
        </span>
      )}
    </span>
  );
}
