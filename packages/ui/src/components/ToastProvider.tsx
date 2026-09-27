import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { ToastContext, type ToastInput } from '../hooks/toast.js';
import { Icon } from './Icon.js';
import styles from './ToastProvider.module.css';

interface ToastItem extends ToastInput {
  id: number;
}

const DOT: Record<NonNullable<ToastInput['tone']>, string> = {
  ok: 'var(--st-ok)',
  warn: 'var(--st-warn)',
  error: 'var(--st-err)',
  off: 'var(--st-off)',
  info: 'var(--sky)',
};

/** Hosts toasts (`useToast()`): bottom-right, auto-dismiss after 5 s, announced politely. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (t: ToastInput) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { ...t, id }]);
      timers.current.set(
        id,
        setTimeout(() => {
          dismiss(id);
        }, 5000),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => {
        clearTimeout(t);
      });
    };
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className={styles.stack} role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={styles.toast}>
            <span
              className={styles.dot}
              style={{ background: DOT[t.tone ?? 'info'] }}
              aria-hidden="true"
            />
            <span className={styles.text}>
              <span className={styles.title}>{t.title}</span>
              {t.detail && <div>{t.detail}</div>}
            </span>
            <button
              type="button"
              className={styles.close}
              aria-label="Dismiss"
              onClick={() => {
                dismiss(t.id);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
