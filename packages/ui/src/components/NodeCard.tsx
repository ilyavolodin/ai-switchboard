import type { StatusTone } from '@ai-switchboard/core/contract';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';

import { cx } from '../lib/cx.js';
import styles from './NodeCard.module.css';

const BORDER: Record<StatusTone, string> = {
  ok: 'var(--st-ok)',
  warn: 'var(--st-warn)',
  error: 'var(--st-err)',
  off: 'var(--line-strong)',
};

export interface NodeCardProps {
  tone: StatusTone;
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
  width?: number;
  href?: string;
  /** Used when `href` is set; defaults to the title. */
  ariaLabel?: string;
  ghost?: boolean;
  dimmed?: boolean;
  highlighted?: boolean;
  describedBy?: string;
  className?: string;
}

export function NodeCard({
  tone,
  title,
  meta,
  children,
  width,
  href,
  ariaLabel,
  ghost,
  dimmed,
  highlighted,
  describedBy,
  className,
}: NodeCardProps) {
  const style = { width, '--node-border': BORDER[tone] } as CSSProperties;
  const cls = cx(
    styles.card,
    ghost && styles.ghost,
    dimmed && styles.dimmed,
    highlighted && styles.highlighted,
    className,
  );
  const content = (
    <>
      <div className={styles.head}>
        <span className={styles.title} title={title}>
          {title}
        </span>
        {meta != null && <span className={styles.meta}>{meta}</span>}
      </div>
      {children != null && <div className={styles.body}>{children}</div>}
    </>
  );
  if (href) {
    return (
      <Link
        to={href}
        className={cls}
        style={style}
        aria-label={ariaLabel ?? title}
        aria-describedby={describedBy}
        data-tone={tone}
      >
        {content}
      </Link>
    );
  }
  return (
    <div className={cls} style={style} data-tone={tone}>
      {content}
    </div>
  );
}
