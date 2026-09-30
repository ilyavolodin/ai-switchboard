import { isPlainObject } from '../../lib/json.js';

export interface ChangeLine {
  key: string | null;
  before: string;
  after: string;
}

export function auditValue(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v === '' ? '""' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

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
