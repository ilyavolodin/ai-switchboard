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
  /** The border colour is the status tone. */
  tone: StatusTone;
  title: string;
  /** Top-right text ("push", "callback", "disabled"). */
  meta?: ReactNode;
  children?: ReactNode;
  width?: number;
  /** Navigates on click. */
  href?: string;
  /** Accessible name when `href` is set (defaults to the title). */
  ariaLabel?: string;
  /** A dashed placeholder (empty-state ghost nodes). */
  ghost?: boolean;
  /** Faded when outside the focused neighbourhood. */
  dimmed?: boolean;
  highlighted?: boolean;
  /** Id of a hover card describing the node. */
  describedBy?: string;
  className?: string;
}

/**
 * The canvas node shell shared by source, process and destination nodes (and the editor's diagram):
 * a card whose 2 px border is its status colour, a title row and a body row.
 */
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
