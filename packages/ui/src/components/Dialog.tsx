import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    const first =
      node?.querySelector<HTMLElement>('input, textarea, select') ??
      node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (!firstItem || !lastItem) return;
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      opener?.focus();
    };
  }, [open]);

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
