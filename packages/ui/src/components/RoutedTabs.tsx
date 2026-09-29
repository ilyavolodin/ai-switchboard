import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

import { cx } from '../lib/cx.js';
import styles from './RoutedTabs.module.css';

export interface RoutedTabItem {
  to: string;
  label: ReactNode;
  count?: number;
  /** Match the path exactly (for the default tab). */
  end?: boolean;
}

export interface RoutedTabsProps {
  items: RoutedTabItem[];
  label: string;
  extra?: ReactNode;
}

export function RoutedTabs({ items, label, extra }: RoutedTabsProps) {
  return (
    <nav className={styles.tabs} aria-label={label}>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => cx(styles.tab, isActive && styles.active)}
        >
          {item.label}
          {item.count != null && <span className={styles.count}>{item.count}</span>}
        </NavLink>
      ))}
      {extra != null && (
        <>
          <span className={styles.spacer} />
          <div className={styles.extra}>{extra}</div>
        </>
      )}
    </nav>
  );
}
