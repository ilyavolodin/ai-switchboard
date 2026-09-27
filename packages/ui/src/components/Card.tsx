import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import styles from './Card.module.css';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  /** Beside the title in mono (a count) or muted text. */
  meta?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** `lg` uses the 17 px card-title; default is the 15 px panel heading. */
  titleSize?: 'md' | 'lg';
  padding?: 'normal' | 'roomy' | 'flush';
  /** Heading level for the title (default h2). */
  headingLevel?: 2 | 3;
  as?: 'section' | 'div' | 'article';
  children?: ReactNode;
}

/** A surface card (radius-lg, shadow-card) with an optional heading row and actions. */
export function Card({
  title,
  meta,
  subtitle,
  actions,
  titleSize = 'md',
  padding = 'normal',
  headingLevel = 2,
  as: As = 'section',
  className,
  children,
  ...rest
}: CardProps) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const hasHeader = title != null || actions != null;
  return (
    <As
      className={cx(
        styles.card,
        padding === 'flush' && styles.flush,
        padding === 'roomy' && styles.roomy,
        className,
      )}
      {...rest}
    >
      {hasHeader && (
        <div className={styles.header}>
          <div className={styles.titles}>
            {title != null && (
              <div className={styles.titleRow}>
                <H className={cx(styles.title, titleSize === 'lg' && styles.titleLg)}>{title}</H>
                {meta != null && <span className={cx(styles.subtitle, 'mono')}>{meta}</span>}
              </div>
            )}
            {subtitle != null && <span className={styles.subtitle}>{subtitle}</span>}
          </div>
          {actions != null && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      {children}
    </As>
  );
}
