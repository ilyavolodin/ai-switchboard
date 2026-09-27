import { type ReactNode, useId } from 'react';

import { Banner } from '../../components/Banner.js';
import { Icon } from '../../components/Icon.js';
import { cx } from '../../lib/cx.js';
import styles from './ProcessEditor.module.css';

export interface EditorSectionProps {
  title: string;
  /** One line shown beside the title, collapsed or not. */
  summary: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Validation messages that belong to this section (the API's 422 details, client checks). */
  errors?: string[];
  /** Something in the section differs from the saved version. */
  changed?: boolean;
  children?: ReactNode;
}

/** One collapsible section of the process editor, in the document's reading order. */
export function EditorSection({
  title,
  summary,
  open,
  onToggle,
  errors = [],
  changed,
  children,
}: EditorSectionProps) {
  const panelId = useId();
  return (
    <section className={styles.section} aria-label={title}>
      <h2 className={styles.sectionHeading}>
        <button
          type="button"
          className={styles.sectionToggle}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <Icon
            name="chevron-down"
            size={14}
            className={cx(styles.chevron, !open && styles.chevronClosed)}
          />
          <span className={styles.sectionTitle}>{title}</span>
          {changed && (
            <span className={styles.changedDot} title="changed, not saved">
              <span className="visually-hidden">changed</span>
            </span>
          )}
          <span className={styles.sectionSummary}>{summary}</span>
          {errors.length > 0 && (
            <span className={styles.sectionErrorCount}>
              {errors.length} problem{errors.length === 1 ? '' : 's'}
            </span>
          )}
        </button>
      </h2>
      {errors.length > 0 && (
        <Banner tone="error" title={`${title} needs attention`}>
          <ul className={styles.errorList}>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Banner>
      )}
      <div id={panelId} hidden={!open} className={styles.sectionBody}>
        {open && children}
      </div>
    </section>
  );
}
