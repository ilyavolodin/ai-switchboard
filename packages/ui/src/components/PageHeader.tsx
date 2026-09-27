import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { cx } from '../lib/cx.js';
import { Icon } from './Icon.js';
import styles from './PageHeader.module.css';

export interface PageHeaderProps {
  title: ReactNode;
  /** Back link (the ‹ button), e.g. `{ to: '/processes', label: 'Back to all processes' }`. */
  back?: { to: string; label: string };
  /** Beside the title: a status chip, the type, an external id link. */
  meta?: ReactNode;
  description?: ReactNode;
  /** Right side: Run now, the Enabled toggle, Reload. */
  actions?: ReactNode;
  /** 28 px page-title (process detail) instead of the 22 px screen title. */
  size?: 'md' | 'lg';
}

/** The screen header used by list and detail screens: back, title, chips, description, actions. */
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
