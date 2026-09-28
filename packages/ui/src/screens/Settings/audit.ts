/** Rendering helpers for the audit log's before → after column. */

/** Scopes the audit log filters by (what the API writes in `audit_log.scope`). */
export const AUDIT_SCOPES = [
  'process',
  'source',
  'destination',
  'notifier',
  'secret_provider',
  'plugin',
  'approval',
  'run',
  'event',
  'user',
  'token',
  'settings',
];

/** One line of a change: an optional key and the two sides as short text. */
export interface ChangeLine {
  key: string | null;
  before: string;
  after: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A short text for one side: `—` for absent, strings as-is, everything else as compact JSON. */
export function auditValue(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v === '' ? '""' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * The change as lines: two objects diff key by key (only the keys that changed), anything else
 * is one line `before → after`.
 */
export function changeLines(before: unknown, after: unknown): ChangeLine[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const lines = keys
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => ({ key: k, before: auditValue(before[k]), after: auditValue(after[k]) }));
    if (lines.length > 0) return lines;
  }
  return [{ key: null, before: auditValue(before), after: auditValue(after) }];
}
