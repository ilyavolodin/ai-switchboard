import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import styles from './Table.module.css';

/** One column: a header and a cell renderer. */
export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  mono?: boolean;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Visually hidden caption (the table's accessible name). */
  caption: string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
}

/**
 * The few tables the UI keeps (runs, audit). Real `<table>` markup; rows are clickable when
 * `onRowClick` is given (put a link in the first cell too, for keyboard users).
 */
export function Table<T>({ columns, rows, rowKey, caption, onRowClick, empty }: TableProps<T>) {
  return (
    <div className={styles.wrap}>
      <table className={cx(styles.table, onRowClick && styles.clickable)}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={{ width: c.width }}
                className={cx(
                  c.align === 'right' && styles.right,
                  c.align === 'center' && styles.center,
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className={styles.empty}>
                {empty ?? 'Nothing here yet.'}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={
                  onRowClick
                    ? () => {
                        onRowClick(row);
                      }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cx(
                      c.align === 'right' && styles.right,
                      c.align === 'center' && styles.center,
                      c.mono && styles.mono,
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
