import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { cx } from '../lib/cx.js';
import { Icon } from './Icon.js';
import styles from './PageHeader.module.css';

export interface PageHeaderProps {
  title: ReactNode;
  back?: { to: string; label: string };
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  size?: 'md' | 'lg';
}

export function PageHeader({
  title,
  back,
  meta,
  description,
  actions,
  size = 'md',
}: PageHeaderProps) {
  return (
    <div className={styles.header}>
      <div className={styles.main}>
        <div className={styles.titleRow}>
          {back && (
            <Link to={back.to} className={styles.back} aria-label={back.label}>
              <Icon name="back" size={14} />
            </Link>
          )}
          <h1 className={cx(styles.title, size === 'lg' && styles.large)}>{title}</h1>
          {meta != null && <div className={styles.meta}>{meta}</div>}
        </div>
        {description != null && <p className={styles.description}>{description}</p>}
      </div>
      {actions != null && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
