/**
 * Pure helpers for the process editor: new documents and list items, the one-line summaries on
 * collapsed sections, the generated `describe` sentence, the batching coalescing model, and how
 * server validation details map back onto sections and fields.
 */
import type {
  EventTypeSpec,
  Notification,
  ProcessDocument,
  Schedule,
  Step,
  Trigger,
} from '@ai-switchboard/core/contract';

import { describeCron } from '../../lib/cron.js';
import { formatCount, formatDays } from '../../lib/format.js';
import { asSchema } from '../../lib/schema.js';

/** The editor's sections, in reading order. */
export const SECTIONS = [
  'triggers',
  'batching',
  'schedules',
  'gates',
  'budgets',
  'executor',
  'steps',
  'notifications',
] as const;
export type SectionId = (typeof SECTIONS)[number] | 'basics';

/** A blank document, like the core's `defaultProcessDocument`. */
export function newProcessDocument(executorInstanceId: string): ProcessDocument {
  return {
    name: '',
    description: '',
    enabled: false,
    triggers: [],
    schedules: [],
    batching: { debounceSeconds: 30, maxSize: 20, maxAgeSeconds: 600 },
    gates: { approval: 'none', breaker: { threshold: 3, cooldownMinutes: 60 } },
    budgets: { runsPerDay: 20, meterCeilings: {} },
    executor: { instanceId: executorInstanceId, target: {} },
    input: '{ "mode": mode, "runId": run.id, "artifacts": events.artifact }',
    before: [],
    after: [],
    notify: [],
    trackingDeadlineMinutes: 120,
  };
}

/** `t3` when t1 and t2 exist. */
export function nextId(prefix: string, taken: string[]): string {
  let i = 1;
  while (taken.includes(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

export function newTrigger(existing: Trigger[]): Trigger {
  return {
    id: nextId(
      't',
      existing.map((t) => t.id),
    ),
    sourceId: '',
    eventTypes: [],
    describe: '',
    enabled: true,
  };
}

export function newSchedule(existing: Schedule[], timezone: string): Schedule {
  return {
    id: nextId(
      's',
      existing.map((s) => s.id),
    ),
    cron: '0 7 * * *',
    timezone,
    catchUp: 'skip',
    enabled: true,
  };
}

export function newStep(provider: string): Step {
  return { provider, action: '', args: '{}' };
}

export function newNotification(notifierId: string): Notification {
  return { notifierId, template: '"Process " & process.name & " " & run.status', on: ['error'] };
}

/** Declared attributes of the ticked event types: `[name, schema]`, de-duplicated. */
export function declaredAttributes(
  specs: EventTypeSpec[],
  selected: string[],
): { name: string; type: string; description: string }[] {
  const out = new Map<string, { name: string; type: string; description: string }>();
  for (const spec of specs) {
    if (!selected.includes(spec.type)) continue;
    const props = asSchema(asSchema(spec.attributes)?.properties) ?? {};
    for (const [name, raw] of Object.entries(props)) {
      const s = asSchema(raw);
      if (out.has(name) || !s) continue;
      out.set(name, {
        name,
        type: typeof s.type === 'string' ? s.type : 'value',
        description: typeof s.description === 'string' ? s.description : '',
      });
    }
  }
  return [...out.values()];
}

/**
 * A default `describe` sentence: "Linear: Issue labelled or Issue state changed where label is
 * autofix". Equality tests on attributes read as words; anything else is summarised.
 */
export function defaultDescribe(
  sourceName: string,
  specs: EventTypeSpec[],
  eventTypes: string[],
  filter: string | undefined,
): string {
  if (eventTypes.length === 0) return '';
  const titles = eventTypes.map((t) => specs.find((s) => s.type === t)?.title ?? t);
  const source = sourceName.split(' — ')[0] ?? sourceName;
  let text = `${source}: ${titles.join(' or ')}`;
  const f = filter?.trim();
  if (f) {
    const eqs = [...f.matchAll(/attributes\.(\w+)\s*=\s*['"]([^'"]+)['"]/g)].map(
      (m) => `${m[1] ?? ''} is ${m[2] ?? ''}`,
    );
    const ins = [...f.matchAll(/['"]([^'"]+)['"]\s+in\s+/g)].map((m) => `it has ${m[1] ?? ''}`);
    const words = [...eqs, ...ins];
    text += words.length > 0 ? ` where ${words.join(' and ')}` : ' matching the filter';
  }
  return text;
}

/** Events joining at `arrivals` (seconds): which batch each lands in, and when each closes. */
export interface CoalescedBatch {
  events: number[];
  closesAt: number;
  reason: 'debounce' | 'size' | 'age';
}

/**
 * The batching model the editor animates: a batch opens on its first event, every join restarts
 * the debounce; it closes when the debounce elapses, on `maxSize`, or at `maxAgeSeconds` after
 * opening, whichever comes first.
 */
export function coalesce(
  arrivals: number[],
  batching: ProcessDocument['batching'],
): CoalescedBatch[] {
  const { debounceSeconds, maxSize, maxAgeSeconds } = batching;
  const out: CoalescedBatch[] = [];
  let open: { events: number[]; openedAt: number; last: number } | null = null;
  const close = (b: { events: number[]; openedAt: number; last: number }) => {
    const byDebounce = b.last + debounceSeconds;
    const byAge = maxAgeSeconds > 0 ? b.openedAt + maxAgeSeconds : Infinity;
    out.push(
      byAge < byDebounce
        ? { events: b.events, closesAt: byAge, reason: 'age' }
        : { events: b.events, closesAt: byDebounce, reason: 'debounce' },
    );
  };
  for (const [i, t] of arrivals.entries()) {
    if (open) {
      const byAge = maxAgeSeconds > 0 ? open.openedAt + maxAgeSeconds : Infinity;
      if (t > open.last + debounceSeconds || t > byAge) {
        close(open);
        open = null;
      }
    }
    if (!open) open = { events: [i], openedAt: t, last: t };
    else {
      open.events.push(i);
      open.last = t;
    }
    if (open.events.length >= Math.max(1, maxSize)) {
      out.push({ events: open.events, closesAt: t, reason: 'size' });
      open = null;
    }
  }
  if (open) close(open);
  return out;
}

/** "Linear issue.label_added, issue.state_changed" style summary of the triggers. */
export function triggersSummary(doc: ProcessDocument, sourceName: (id: string) => string): string {
  if (doc.triggers.length === 0) return 'no triggers · sweeps only';
  const on = doc.triggers.filter((t) => t.enabled);
  const first = on[0] ?? doc.triggers[0];
  const head = first
    ? `${(sourceName(first.sourceId) || 'no source').split(' — ')[0] ?? ''} ${first.eventTypes.join(', ')}`
    : '';
  return `${on.length} on${doc.triggers.length > on.length ? ` · ${doc.triggers.length - on.length} off` : ''} · ${head}`;
}

export function batchingSummary(b: ProcessDocument['batching']): string {
  return [
    `debounce ${b.debounceSeconds} s`,
    `max ${b.maxSize}`,
    `max age ${b.maxAgeSeconds >= 60 ? `${Math.round(b.maxAgeSeconds / 60)} min` : `${b.maxAgeSeconds} s`}`,
    b.groupBy ? `group by ${b.groupBy}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function schedulesSummary(s: Schedule[]): string {
  if (s.length === 0) return 'no sweeps';
  return s
    .map((x) => {
      const d = describeCron(x.cron);
      return `${d.ok ? d.text : x.cron} ${x.timezone}${x.enabled ? '' : ' (off)'} · catch-up ${x.catchUp}`;
    })
    .join(' · ');
}

export function gatesSummary(g: ProcessDocument['gates']): string {
  return [
    g.quietHours
      ? `quiet ${g.quietHours.start}–${g.quietHours.end} ${formatDays(g.quietHours.days)}`
      : 'no quiet hours',
    `approval ${g.approval === 'none' || g.approval === 'always' ? g.approval : 'by expression'}`,
    `breaker ${g.breaker.threshold} failures, cooldown ${g.breaker.cooldownMinutes} min`,
  ].join(' · ');
}

export function budgetsSummary(b: ProcessDocument['budgets']): string {
  const parts = [
    b.runsPerHour != null ? `${b.runsPerHour} / h` : null,
    b.runsPerDay != null ? `${b.runsPerDay} / d` : null,
    ...Object.entries(b.usagePerDay ?? {}).map(([k, v]) => `${formatCount(v)} ${k}`),
  ].filter(Boolean);
  const ceilings = Object.values(b.meterCeilings);
  if (ceilings.length > 0) {
    parts.push(
      `ceilings ${[...new Set(ceilings.map((c) => `${c.events}% / ${c.sweeps}%`))].join(', ')}`,
    );
  }
  return parts.length > 0 ? parts.join(' · ') : 'no caps';
}

export function stepsSummary(doc: ProcessDocument): string {
  const fmt = (s: Step) => `${s.action || '(no action)'}${s.when ? ` when ${s.when}` : ''}`;
  const parts = [
    doc.before.length > 0 ? `before: ${doc.before.map(fmt).join(', ')}` : null,
    doc.after.length > 0 ? `after: ${doc.after.map(fmt).join(', ')}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'no steps';
}

export function notificationsSummary(
  n: Notification[],
  notifierName: (id: string) => string,
): string {
  if (n.length === 0) return 'no notifications';
  return n
    .map((x) => `${notifierName(x.notifierId) || 'no notifier'} on ${x.on.join(', ')}`)
    .join(' · ');
}

/** An empty input means "no cap"; anything else is a non-negative number (or `NaN`). */
export function parseCap(text: string): number | undefined {
  const t = text.trim().replace(/_/g, '');
  if (t === '') return undefined;
  const k = /^(\d+(?:\.\d+)?)\s*([kKmM])$/.exec(t);
  if (k) return Number(k[1]) * (k[2]?.toLowerCase() === 'k' ? 1000 : 1_000_000);
  return Number(t);
}

/** One validation message and where it belongs. */
export interface PlacedError {
  /** JSON pointer into the document, e.g. `/budgets/runsPerHour`, or `''`. */
  pointer: string;
  message: string;
  section: SectionId | null;
}

const SECTION_OF: Record<string, SectionId> = {
  name: 'basics',
  description: 'basics',
  enabled: 'basics',
  triggers: 'triggers',
  batching: 'batching',
  schedules: 'schedules',
  gates: 'gates',
  budgets: 'budgets',
  executor: 'executor',
  input: 'executor',
  trackingDeadlineMinutes: 'executor',
  before: 'steps',
  after: 'steps',
  notify: 'notifications',
};

/** The section a top-level document key is edited in. */
export function sectionForKey(key: string | number | undefined): SectionId | null {
  return typeof key === 'string' ? (SECTION_OF[key] ?? null) : null;
}

/**
 * Places API validation details ("/budgets/runsPerHour must be >= 0", "document/triggers/0: …")
 * on a section by the first pointer segment. Details without a pointer stay general.
 */
export function placeErrors(details: string[]): PlacedError[] {
  return details.map((d) => {
    const m = /^(?:document)?(\/[^\s:]*)\s*:?\s*(.*)$/.exec(d.trim());
    if (!m) return { pointer: '', message: d, section: null };
    const pointer = m[1] ?? '';
    const first = pointer.split('/')[1] ?? '';
    const rest = m[2] ?? '';
    return { pointer, message: rest === '' ? d : rest, section: SECTION_OF[first] ?? null };
  });
}

/** Client-side checks the API would also reject, keyed by pointer. */
export function checkDocument(doc: ProcessDocument): Record<string, string> {
  const out: Record<string, string> = {};
  if (!doc.name.trim()) out['/name'] = 'A process needs a name';
  doc.triggers.forEach((t, i) => {
    if (!t.sourceId) out[`/triggers/${i}/sourceId`] = 'Pick a source';
    else if (t.eventTypes.length === 0)
      out[`/triggers/${i}/eventTypes`] = 'Tick at least one event type';
  });
  if (!doc.executor.instanceId) out['/executor/instanceId'] = 'Pick an executor';
  doc.schedules.forEach((s, i) => {
    if (!describeCron(s.cron).ok) out[`/schedules/${i}/cron`] = 'Fix the cron expression';
  });
  return out;
}
