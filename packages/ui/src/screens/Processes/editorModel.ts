import type {
  EventTypeSpec,
  MeterCeiling,
  MeterGaugeDTO,
  Notification,
  ProcessDocument,
  Schedule,
  Step,
  Trigger,
} from '@ai-switchboard/core/contract';
import {
  approvalMode,
  defaultProcessDocument,
  processDocumentSchema,
} from '@ai-switchboard/core/domain';

import { errorMessage, isApiRequestError } from '../../api/client.js';
import { describeCron } from '../../lib/cron.js';
import { formatCount, formatDays } from '../../lib/format.js';
import { shortInstanceName } from '../../lib/instanceNames.js';
import { asSchema, validateAgainstSchema } from '../../lib/schema.js';

export { approvalMode, type ApprovalMode } from '@ai-switchboard/core/domain';

export const SECTIONS = [
  'triggers',
  'batching',
  'schedules',
  'gates',
  'budgets',
  'destination',
  'steps',
  'notifications',
] as const;
export type EditorSectionId = (typeof SECTIONS)[number];
export type SectionId = EditorSectionId | 'basics';

export const SECTION_TITLES: Record<EditorSectionId, string> = {
  triggers: 'Triggers',
  batching: 'Batching',
  schedules: 'Schedules',
  gates: 'Gates',
  budgets: 'Budgets',
  destination: 'Destination',
  steps: 'Steps',
  notifications: 'Notifications',
};

export interface DocumentNames {
  sourceName: (id: string) => string;
  notifierName: (id: string) => string;
  destinationName: string | undefined;
}

/** The line each collapsed section shows. */
export function sectionSummaries(
  doc: ProcessDocument,
  names: DocumentNames,
): Record<EditorSectionId, string> {
  return {
    triggers: triggersSummary(doc, names.sourceName),
    batching: batchingSummary(doc.batching),
    schedules: schedulesSummary(doc.schedules),
    gates: gatesSummary(doc.gates),
    budgets: budgetsSummary(doc.budgets),
    destination: destinationSectionSummary(doc, names.destinationName),
    steps: stepsSummary(doc),
    notifications: notificationsSummary(doc.notify, names.notifierName),
  };
}

/** Unlike the core's default, enabled: a process made in the editor is meant to run. */
export function newProcessDocument(destinationInstanceId: string): ProcessDocument {
  return { ...defaultProcessDocument('', destinationInstanceId), enabled: true };
}

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

export function defaultDescribe(
  sourceName: string,
  specs: EventTypeSpec[],
  eventTypes: string[],
  filter: string | undefined,
): string {
  if (eventTypes.length === 0) return '';
  const titles = eventTypes.map((t) => specs.find((s) => s.type === t)?.title ?? t);
  const source = shortInstanceName(sourceName);
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

export function triggersSummary(doc: ProcessDocument, sourceName: (id: string) => string): string {
  if (doc.triggers.length === 0) return 'no triggers · sweeps only';
  const on = doc.triggers.filter((t) => t.enabled);
  const first = on[0] ?? doc.triggers[0];
  const head = first
    ? `${shortInstanceName(sourceName(first.sourceId) || 'no source')} ${first.eventTypes.join(', ')}`
    : '';
  return `${on.length} on${doc.triggers.length > on.length ? ` · ${doc.triggers.length - on.length} off` : ''} · ${head}`;
}

type Batching = ProcessDocument['batching'];
type Budgets = ProcessDocument['budgets'];

export const BATCHING_DEFAULTS: Batching = defaultProcessDocument('', '').batching;

/**
 * `maxSize: 1` closes a batch on its first event. Debounce and max age are 0 so the document reads
 * the same way (`maxAgeSeconds: 0` is "no age cap").
 */
export const BATCHING_OFF: Batching = { debounceSeconds: 0, maxSize: 1, maxAgeSeconds: 0 };

/**
 * No field of its own: at `maxSize` 1 the batch closes on arrival whatever the debounce and age
 * say, so that is exactly "off" in the pipeline too.
 */
export function batchingOn(b: Batching): boolean {
  return b.maxSize > 1;
}

/**
 * Off drops the group-by (one-event batches have nothing to group). On restores `previous` when it
 * batched, else the defaults.
 */
export function withBatching(
  doc: ProcessDocument,
  on: boolean,
  previous?: Batching,
): ProcessDocument {
  if (!on) return { ...doc, batching: { ...BATCHING_OFF } };
  const restored = previous && batchingOn(previous) ? previous : BATCHING_DEFAULTS;
  return { ...doc, batching: { ...restored } };
}

export const BUDGETS_DEFAULTS: Budgets = defaultProcessDocument('', '').budgets;

/** Any run cap, usage cap or meter ceiling counts; "off" is `{ meterCeilings: {} }`. */
export function budgetsOn(b: Budgets): boolean {
  return (
    b.runsPerHour != null ||
    b.runsPerDay != null ||
    Object.keys(b.usagePerDay ?? {}).length > 0 ||
    Object.keys(b.meterCeilings).length > 0
  );
}

export function withBudgets(
  doc: ProcessDocument,
  on: boolean,
  previous?: Budgets,
): ProcessDocument {
  if (!on) return { ...doc, budgets: { meterCeilings: {} } };
  const restored = previous && budgetsOn(previous) ? previous : BUDGETS_DEFAULTS;
  return {
    ...doc,
    budgets: { ...restored, meterCeilings: { ...restored.meterCeilings } },
  };
}

/** A ceiling of 100% throttles nothing; the inputs show it as empty. */
export const NO_CEILING = 100;

export function withCeiling(
  doc: ProcessDocument,
  meterId: string,
  kind: keyof MeterCeiling,
  value: number | undefined,
): ProcessDocument {
  const current = doc.budgets.meterCeilings[meterId] ?? { events: NO_CEILING, sweeps: NO_CEILING };
  const next = { ...current, [kind]: value ?? NO_CEILING };
  const { [meterId]: _drop, ...others } = doc.budgets.meterCeilings;
  const meterCeilings =
    next.events === NO_CEILING && next.sweeps === NO_CEILING
      ? others
      : { ...others, [meterId]: next };
  return { ...doc, budgets: { ...doc.budgets, meterCeilings } };
}

export function withUsageCap(
  doc: ProcessDocument,
  dimension: string,
  value: number | undefined,
): ProcessDocument {
  const { [dimension]: _drop, ...others } = doc.budgets.usagePerDay ?? {};
  const usagePerDay = value == null ? others : { ...others, [dimension]: value };
  const { usagePerDay: _old, ...budgets } = doc.budgets;
  return {
    ...doc,
    budgets: Object.keys(usagePerDay).length > 0 ? { ...budgets, usagePerDay } : budgets,
  };
}

/** Another destination has other usage and meters: its target, usage caps and ceilings reset. */
export function withDestination(doc: ProcessDocument, instanceId: string): ProcessDocument {
  const { usagePerDay: _drop, ...budgets } = doc.budgets;
  return {
    ...doc,
    destination: { instanceId, target: {} },
    budgets: { ...budgets, meterCeilings: {} },
  };
}

/** The draft's own ceiling on each meter, for the gauge marks while editing. */
export function draftMeterCeilings<M extends { meterId: string }>(
  meters: M[],
  doc: ProcessDocument,
  processId: string,
): (M & { ceilings: MeterGaugeDTO['ceilings'] })[] {
  return meters.map((m) => {
    const c = doc.budgets.meterCeilings[m.meterId];
    return {
      ...m,
      ceilings: c ? [{ processId, processName: doc.name, events: c.events, sweeps: c.sweeps }] : [],
    };
  });
}

export function destinationSectionSummary(
  doc: ProcessDocument,
  destinationName: string | undefined,
): string {
  return `${destinationName ?? 'no destination'} · ${doc.trackingDeadlineMinutes} min tracking deadline`;
}

export function batchingSummary(b: ProcessDocument['batching']): string {
  if (!batchingOn(b)) return 'Off — one run per event';
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
      return `${describeCron(x.cron) ?? x.cron} ${x.timezone}${x.enabled ? '' : ' (off)'} · catch-up ${x.catchUp}`;
    })
    .join(' · ');
}

export function gatesSummary(g: ProcessDocument['gates']): string {
  return [
    g.quietHours
      ? `quiet ${g.quietHours.start}–${g.quietHours.end} ${formatDays(g.quietHours.days)}`
      : 'no quiet hours',
    `approval ${approvalLabel(g.approval)}`,
    `breaker ${g.breaker.threshold} failures, cooldown ${g.breaker.cooldownMinutes} min`,
  ].join(' · ');
}

/** The diagram's short form of `gatesSummary`. */
export function gatesBrief(g: ProcessDocument['gates']): string[] {
  return [
    g.quietHours ? `quiet hours ${g.quietHours.start}–${g.quietHours.end}` : null,
    `approval ${approvalLabel(g.approval)}`,
    `breaker ${g.breaker.threshold}/${g.breaker.cooldownMinutes} min`,
  ].filter((p): p is string => p != null);
}

/** The diagram's short form of `budgetsSummary`: run caps, then whether usage caps are set. */
export function budgetsBrief(b: Budgets): string[] {
  return [
    b.runsPerHour != null ? `${b.runsPerHour}/h` : null,
    b.runsPerDay != null ? `${b.runsPerDay}/d` : null,
    Object.keys(b.usagePerDay ?? {}).length > 0 ? 'usage caps' : null,
  ].filter((p): p is string => p != null);
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
  return parts.length > 0 ? parts.join(' · ') : 'No limits';
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

export function parseCap(text: string): number | undefined {
  const t = text.trim().replace(/_/g, '');
  if (t === '') return undefined;
  const k = /^(\d+(?:\.\d+)?)\s*([kKmM])$/.exec(t);
  if (k) return Number(k[1]) * (k[2]?.toLowerCase() === 'k' ? 1000 : 1_000_000);
  return Number(t);
}

export interface PlacedError {
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
  destination: 'destination',
  input: 'destination',
  trackingDeadlineMinutes: 'destination',
  before: 'steps',
  after: 'steps',
  notify: 'notifications',
};

export function sectionForKey(key: string | number | undefined): SectionId | null {
  return typeof key === 'string' ? (SECTION_OF[key] ?? null) : null;
}

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

const FRIENDLY: [RegExp, string][] = [
  [/^\/name$/, 'A process needs a name'],
  [/^\/triggers\/\d+\/sourceId$/, 'Pick a source'],
  [/^\/triggers\/\d+\/eventTypes$/, 'Tick at least one event type'],
  [/^\/destination\/instanceId$/, 'Pick a destination'],
  [/^\/schedules\/\d+\/cron$/, 'Enter a cron expression'],
];

/**
 * The core's document schema, plus what it leaves to the server (a blank name or cron, a
 * destination). A problem no section can show is left for the server to report.
 */
export function checkDocument(doc: ProcessDocument): Record<string, string> {
  const out: Record<string, string> = {};
  // Event types are asked for once a source is picked.
  const later = new Set(
    doc.triggers.flatMap((t, i) => (t.sourceId ? [] : [`/triggers/${i}/eventTypes`])),
  );
  const add = (pointer: string, fallback: string) => {
    if (later.has(pointer)) return;
    out[pointer] ??= FRIENDLY.find(([re]) => re.test(pointer))?.[1] ?? fallback;
  };
  for (const [pointer, messages] of Object.entries(
    validateAgainstSchema(processDocumentSchema, doc),
  )) {
    if (sectionForKey(pointer.split('/')[1]) != null) add(pointer, messages[0] ?? 'Invalid value');
  }
  if (!doc.name.trim()) add('/name', '');
  if (!doc.destination.instanceId) add('/destination/instanceId', '');
  doc.schedules.forEach((s, i) => {
    if (!s.cron.trim()) add(`/schedules/${i}/cron`, '');
  });
  return out;
}

export interface EditorErrors {
  /** A client check wins over a server detail on the same pointer. */
  byPointer: Record<string, string>;
  bySection: Partial<Record<SectionId, string[]>>;
  general: PlacedError[];
}

export function collectErrors(client: Record<string, string>, server: PlacedError[]): EditorErrors {
  const byPointer: Record<string, string> = { ...client };
  for (const e of server) if (e.pointer && !byPointer[e.pointer]) byPointer[e.pointer] = e.message;
  const bySection: Partial<Record<SectionId, string[]>> = {};
  const add = (section: SectionId | null, message: string) => {
    if (section == null) return;
    (bySection[section] ??= []).push(message);
  };
  for (const [pointer, message] of Object.entries(client)) {
    add(sectionForKey(pointer.split('/')[1]), message);
  }
  for (const e of server) add(e.section, `${e.pointer} ${e.message}`.trim());
  return { byPointer, bySection, general: server.filter((e) => e.section == null) };
}

export function errorsUnder(
  errors: Record<string, string>,
  prefix: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors)
      .filter(([p]) => p.startsWith(`${prefix}/`))
      .map(([p, m]) => [p.slice(prefix.length), m]),
  );
}

export function saveConsequence(opts: {
  isNew: boolean;
  enabled: boolean;
  changes: string[];
  baseVersion: number;
}): string {
  if (opts.isNew) {
    return `The process is created ${
      opts.enabled
        ? 'enabled: its triggers and sweeps start runs right away'
        : 'disabled; enable it when you are ready'
    }.`;
  }
  const n = opts.changes.length;
  const listed = opts.changes.slice(0, 3).join('; ') + (n > 3 ? '; …' : '');
  return `${n} change${n === 1 ? '' : 's'}: ${listed}. Saving writes version ${opts.baseVersion + 1}.`;
}

export type SaveFailure =
  | { kind: 'conflict' }
  | { kind: 'invalid'; placed: PlacedError[]; message: string }
  | { kind: 'other'; message: string };

export function classifySaveError(e: unknown): SaveFailure {
  if (isApiRequestError(e) && e.status === 409) return { kind: 'conflict' };
  if (isApiRequestError(e) && (e.status === 422 || e.status === 400) && e.body.details?.length) {
    return { kind: 'invalid', placed: placeErrors(e.body.details), message: e.body.message };
  }
  return { kind: 'other', message: errorMessage(e) };
}

export interface StepProviderRef {
  id: string;
  name: string;
  kind: 'source' | 'destination';
}

export function stepProviders(
  doc: ProcessDocument,
  sourceName: (id: string) => string,
  destinationName: string | undefined,
): StepProviderRef[] {
  const sources = [...new Set(doc.triggers.map((t) => t.sourceId).filter(Boolean))].map(
    (id): StepProviderRef => ({ id, name: sourceName(id) || id, kind: 'source' }),
  );
  const destinationId = doc.destination.instanceId;
  return destinationId
    ? [
        ...sources,
        { id: destinationId, name: destinationName ?? destinationId, kind: 'destination' },
      ]
    : sources;
}

export function problemSections(problems: Record<string, string>): (SectionId | null)[] {
  return Object.keys(problems).map((p) => sectionForKey(p.split('/')[1]));
}

export function updateAt<T>(list: T[], index: number, patch: Partial<T>): T[] {
  return list.map((x, j) => (j === index ? { ...x, ...patch } : x));
}

export function replaceAt<T>(list: T[], index: number, next: T): T[] {
  return list.map((x, j) => (j === index ? next : x));
}

export function removeAt<T>(list: T[], index: number): T[] {
  return list.filter((_, j) => j !== index);
}

/** Sets `key`, or drops it when `value` is undefined, so a cleared field leaves no key behind. */
export function setOptionalKey<T extends object, K extends keyof T>(
  obj: T,
  key: K,
  value: T[K] | undefined,
): T {
  const { [key]: _drop, ...rest } = obj;
  return (value === undefined ? rest : { ...rest, [key]: value }) as T;
}

export function approvalLabel(approval: string): string {
  const mode = approvalMode(approval);
  return mode === 'expression' ? 'by expression' : mode;
}
