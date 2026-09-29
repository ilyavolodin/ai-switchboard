import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  illustration?: 'ghost' | 'none';
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  title,
  children,
  actions,
  illustration = 'none',
  compact,
  className,
}: EmptyStateProps) {
  return (
    <div className={cx(styles.empty, compact && styles.compact, className)}>
      {illustration === 'ghost' && (
        <div className={styles.ghost} aria-hidden="true">
          <span className={styles.ghostNode} />
          <span className={styles.ghostEdge} />
          <span className={styles.ghostNode} />
          <span className={styles.ghostEdge} />
          <span className={styles.ghostNode} />
        </div>
      )}
      <div className={styles.title}>{title}</div>
      {children != null && <div className={styles.body}>{children}</div>}
      {actions != null && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
