import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import styles from './Banner.module.css';
import { Icon, type IconName } from './Icon.js';

export type BannerTone = 'error' | 'warn' | 'info' | 'neutral';

export interface BannerProps {
  tone: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  icon?: IconName;
  size?: 'md' | 'lg';
  className?: string;
}

const DEFAULT_ICON: Record<BannerTone, IconName> = {
  error: 'warning',
  warn: 'warning',
  info: 'info',
  neutral: 'info',
};

export function Banner({
  tone,
  title,
  children,
  actions,
  icon,
  size = 'md',
  className,
}: BannerProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx(styles.banner, styles[tone], size === 'lg' && styles.lg, className)}
    >
      <span className={styles.icon}>
        <Icon name={icon ?? DEFAULT_ICON[tone]} size={size === 'lg' ? 16 : 14} />
      </span>
      <span className={styles.content}>
        {title != null && <span className={styles.title}>{title}</span>}
        {title != null && children != null && ' — '}
        {children}
      </span>
      {actions != null && <span className={styles.actions}>{actions}</span>}
    </div>
  );
}
