import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { cx } from '../lib/cx.js';
import styles from './Drawer.module.css';
import { IconButton } from './IconButton.js';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** `right` side panel (desktop) or `bottom` sheet (phone). */
  side?: 'right' | 'bottom';
  width?: number;
}

/** A side panel / bottom sheet (event detail, run detail). Escape and the backdrop close it. */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  side = 'right',
  width,
}: DrawerProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <>
      <div className={styles.overlay} onMouseDown={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(styles.drawer, side === 'bottom' && styles.bottom)}
        style={width && side === 'right' ? { width } : undefined}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <IconButton icon="close" label="Close" variant="ghost" onClick={onClose} />
        </div>
        <div className={styles.body}>{children}</div>
        {footer != null && <div className={styles.footer}>{footer}</div>}
      </div>
    </>,
    document.body,
  );
}
