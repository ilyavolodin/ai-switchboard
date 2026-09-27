import { type ReactNode, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useModal } from '../hooks/useModal.js';
import { cx } from '../lib/cx.js';
import styles from './Dialog.module.css';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'wide';
  /** Clicking the backdrop closes (default true). */
  dismissible?: boolean;
}

/**
 * A modal dialog in a portal: `role="dialog"`, `aria-modal`, labelled by its title. Focus moves
 * to the first field (or button) and is kept inside; Escape closes; focus returns to the opener.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: DialogProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, open, onClose);

  if (!open) return null;
  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(styles.dialog, size === 'wide' && styles.wide)}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {children != null && <div className={styles.body}>{children}</div>}
        {footer != null && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
