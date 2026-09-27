import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';

import { cx } from '../lib/cx.js';
import styles from './Tabs.module.css';

/** One local tab. */
export interface TabItem {
  value: string;
  label: ReactNode;
  count?: number;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Right-aligned content in the tab row (a window picker). */
  extra?: ReactNode;
  /** Id prefix used to link tabs and panels: panels use `${idBase}-panel-${value}`. */
  idBase?: string;
}

/**
 * Local (in-page) tabs with the underline style and arrow-key navigation. Render the active
 * panel yourself with `role="tabpanel"` and `id={tabPanelId(idBase, value)}`. For tabs that are
 * URLs use `RoutedTabs`.
 */
export function Tabs({ items, value, onChange, label, extra, idBase }: TabsProps) {
  const auto = useId();
  const base = idBase ?? auto;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, index: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (index + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    const item = items[next];
    if (item) {
      onChange(item.value);
      refs.current[next]?.focus();
    }
  };
  return (
    <div className={styles.tabs}>
      <div role="tablist" aria-label={label} style={{ display: 'contents' }}>
        {items.map((item, i) => {
          const selected = item.value === value;
          return (
            <button
              key={item.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${item.value}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${item.value}`}
              tabIndex={selected ? 0 : -1}
              className={cx(styles.tab, selected && styles.active)}
              onClick={() => {
                onChange(item.value);
              }}
              onKeyDown={(e) => {
                onKey(e, i);
              }}
            >
              {item.label}
              {item.count != null && <span className={styles.count}>{item.count}</span>}
            </button>
          );
        })}
      </div>
      {extra != null && (
        <>
          <span className={styles.spacer} />
          <div className={styles.extra}>{extra}</div>
        </>
      )}
    </div>
  );
}
