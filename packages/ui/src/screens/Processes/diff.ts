import { isPlainObject } from '../../lib/json.js';

export interface Change {
  path: (string | number)[];
  before: unknown;
  after: unknown;
}

export function diffValues(
  before: unknown,
  after: unknown,
  path: (string | number)[] = [],
): Change[] {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: Change[] = [];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      const b: unknown = before[i];
      const a: unknown = after[i];
      if (i >= before.length || i >= after.length)
        out.push({ path: [...path, i], before: b, after: a });
      else out.push(...diffValues(b, a, [...path, i]));
    }
    return out;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((k) => diffValues(before[k], after[k], [...path, k]));
  }
  if (before === undefined && after === undefined) return [];
  return [{ path, before, after }];
}

const LABELS: Record<string, string> = {
  name: 'name',
  description: 'description',
  enabled: 'enabled',
  triggers: 'trigger',
  schedules: 'schedule',
  sourceId: 'source',
  eventTypes: 'event types',
  filter: 'filter',
  describe: 'description',
  cron: 'cron',
  timezone: 'timezone',
  catchUp: 'catch-up',
  batching: '',
  debounceSeconds: 'debounce',
  maxSize: 'max size',
  maxAgeSeconds: 'max age',
  groupBy: 'group by',
  gates: '',
  quietHours: 'quiet hours',
  start: 'start',
  end: 'end',
  days: 'days',
  approval: 'approval',
  breaker: 'breaker',
  threshold: 'threshold',
  cooldownMinutes: 'cooldown',
  budgets: '',
  runsPerHour: 'runs per hour',
  runsPerDay: 'runs per day',
  usagePerDay: 'per day',
  meterCeilings: 'ceiling',
  events: 'events',
  sweeps: 'sweeps',
  destination: 'destination',
  instanceId: 'instance',
  target: 'target',
  input: 'input mapping',
  before: 'before step',
  after: 'after step',
  provider: 'provider',
  action: 'action',
  args: 'args',
  when: 'condition',
  notify: 'notification',
  notifierId: 'notifier',
  template: 'template',
  on: 'on',
  trackingDeadlineMinutes: 'tracking deadline',
};

export function changeLabel(path: (string | number)[]): string {
  const parts: string[] = [];
  let parent: string | number | undefined;
  for (const seg of path) {
    if (typeof seg === 'number') {
      if (parent === 'eventTypes' || parent === 'days' || parent === 'on') {
        // list values read as one field
      } else parts.push(String(seg + 1));
    } else if (parent === 'meterCeilings' || parent === 'target' || parent === 'usagePerDay') {
      parts.push(seg);
    } else {
      const label = LABELS[seg] ?? seg;
      if (label) parts.push(label);
    }
    parent = seg;
  }
  // "per day input_tokens" reads better as "input_tokens per day"
  const i = parts.indexOf('per day');
  if (i >= 0 && i < parts.length - 1) {
    const [dim] = parts.splice(i + 1, 1);
    parts.splice(i, 0, dim ?? '');
  }
  return parts.join(' ').trim() || 'document';
}

export function formatChangeValue(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 39)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const json = JSON.stringify(v);
  return json.length > 40 ? `${json.slice(0, 39)}…` : json;
}

export function describeChange(c: Change): string {
  return `${changeLabel(c.path)} ${formatChangeValue(c.before)} → ${formatChangeValue(c.after)}`;
}

export function groupChanges(changes: Change[], before: unknown, after: unknown): Change[] {
  const listKeys = new Set(['eventTypes', 'days', 'on']);
  const out: Change[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    const idx = c.path.findIndex((p) => typeof p === 'string' && listKeys.has(p));
    if (idx >= 0 && idx < c.path.length - 1) {
      const listPath = c.path.slice(0, idx + 1);
      const key = JSON.stringify(listPath);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path: listPath,
        before: getPath(before, listPath),
        after: getPath(after, listPath),
      });
    } else out.push(c);
  }
  return out;
}

function getPath(v: unknown, path: (string | number)[]): unknown {
  let cur: unknown = v;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

export function documentChanges(before: unknown, after: unknown): Change[] {
  return groupChanges(diffValues(before, after), before, after);
}
