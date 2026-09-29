import type { ReactNode } from 'react';

import { Button } from '../../components/Button.js';
import styles from './ProcessEditor.module.css';

export interface RepeatableItemProps {
  label: string;
  overline: string;
  onRemove: () => void;
  disabled?: boolean;
  /** Controls between the overline and the summary, e.g. an enabled switch. */
  lead?: ReactNode;
  summary?: ReactNode;
  /** Controls before Remove. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function RepeatableItem({
  label,
  overline,
  onRemove,
  disabled,
  lead,
  summary,
  actions,
  children,
}: RepeatableItemProps) {
  return (
    <div className={styles.item} role="group" aria-label={label}>
      <div className={styles.itemHead}>
        <span className="t-overline">{overline}</span>
        {lead}
        <span className={styles.itemSummary}>{summary}</span>
        {actions}
        <Button size="sm" variant="outline" onClick={onRemove} disabled={disabled}>
          Remove
        </Button>
      </div>
      {children}
    </div>
  );
}
