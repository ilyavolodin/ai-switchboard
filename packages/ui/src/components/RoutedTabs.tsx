import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

import { cx } from '../lib/cx.js';
import styles from './RoutedTabs.module.css';

/** One routed tab: a link to its URL. */
export interface RoutedTabItem {
  to: string;
  label: ReactNode;
  count?: number;
  /** Match the path exactly (use for the default/overview tab). */
  end?: boolean;
}

export interface RoutedTabsProps {
  items: RoutedTabItem[];
  /** Accessible name of the navigation. */
  label: string;
  extra?: ReactNode;
}

/**
 * Tabs that are URLs (`/processes/:id/:tab`): a nav of links with the underline style; the
 * active one has `aria-current="page"`.
 */
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
