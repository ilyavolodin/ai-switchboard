import { type ReactNode, useState } from 'react';

import styles from './KeyValueList.module.css';

export interface KeyValueListProps {
  /** A record (attributes, settings) or explicit pairs. */
  data: Record<string, unknown> | [string, ReactNode][];
  /** Rows shown before "show all N" (collapsible). Omit to show everything. */
  initialRows?: number;
  label?: string;
}

function scalar(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function render(v: unknown): ReactNode {
  if (v == null) return '—';
  // Lists can hold objects (a trace's budget `checks`): each element is shown as JSON.
  if (Array.isArray(v)) return v.map(scalar).join(', ');
  return scalar(v);
}

/** Attributes as a key/value list in mono, collapsible after `initialRows`. */
export function KeyValueList({ data, initialRows, label }: KeyValueListProps) {
  const [open, setOpen] = useState(false);
  const rows: [string, ReactNode][] = Array.isArray(data)
    ? data
    : Object.entries(data).map(([k, v]) => [k, render(v)]);
  const limit = initialRows != null && !open ? initialRows : rows.length;
  const shown = rows.slice(0, limit);
  return (
    <dl className={styles.list} aria-label={label}>
      {shown.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt className={styles.key}>{k}</dt>
          <dd className={styles.value}>{v}</dd>
        </div>
      ))}
      {initialRows != null && rows.length > initialRows && (
        <button
          type="button"
          className={styles.more}
          aria-expanded={open}
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          {open ? 'show fewer' : `show all ${rows.length}`}
        </button>
      )}
    </dl>
  );
}
