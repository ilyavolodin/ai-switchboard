import { cx } from '../lib/cx.js';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  shape?: 'rect' | 'circle' | 'card';
  /** Repeat as a stack of lines. */
  lines?: number;
  className?: string;
  /** Announced once for the whole region. */
  label?: string;
}

/** A loading placeholder (shimmering block, circle or card); `lines` stacks text lines. */
export function Skeleton({
  width = '100%',
  height = 14,
  shape = 'rect',
  lines,
  className,
  label,
}: SkeletonProps) {
  const block = (key?: number) => (
    <span
      key={key}
      className={cx(
        styles.skeleton,
        shape === 'circle' && styles.circle,
        shape === 'card' && styles.card,
        className,
      )}
      style={{
        width: lines && key != null && key === lines - 1 ? '60%' : width,
        height,
      }}
    />
  );
  return (
    <span
      role="status"
      aria-label={label ?? 'Loading'}
      aria-busy="true"
      className={lines ? styles.stack : undefined}
    >
      {lines ? Array.from({ length: lines }, (_, i) => block(i)) : block()}
    </span>
  );
}
