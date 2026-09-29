export interface Suggestion {
  value: string;
  hint?: string;
  detail?: string;
}

export interface DeliverySample {
  body: unknown;
  headers: Record<string, string>;
  query: Record<string, string>;
}

const MAX_PATHS = 400;
const MAX_DEPTH = 8;

function example(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `list of ${value.length}`;
  if (typeof value === 'object') return 'object';
  const text =
    typeof value === 'string'
      ? `"${value}"`
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lists offer their first items by index (`body.labels.0`) and, for lists of objects, each field
 * across the list (`body.labels.name`), as the webhook reads them.
 */
export function samplePaths(sample: DeliverySample): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (path: string, value: unknown) => {
    if (out.length >= MAX_PATHS || seen.has(path)) return;
    seen.add(path);
    out.push({ value: path, hint: example(value) });
  };
  const walk = (value: unknown, path: string, depth: number) => {
    add(path, value);
    if (depth >= MAX_DEPTH) return;
    if (Array.isArray(value)) {
      value.slice(0, 3).forEach((item, i) => {
        walk(item, `${path}.${i}`, depth + 1);
      });
      const fields = new Map<string, unknown[]>();
      for (const item of value) {
        if (!isRecord(item)) continue;
        for (const [k, v] of Object.entries(item)) fields.set(k, [...(fields.get(k) ?? []), v]);
      }
      for (const [k, values] of fields) add(`${path}.${k}`, values.flat());
    } else if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, depth + 1);
    }
  };
  walk(sample.body, 'body', 0);
  for (const [k, v] of Object.entries(sample.headers)) add(`headers.${k.toLowerCase()}`, v);
  for (const [k, v] of Object.entries(sample.query)) add(`query.${k}`, v);
  return out;
}

/** `null` when it is not JSON: the webhook would read it as text, but paths need structure. */
export function parseSampleBody(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Prefix matches first, then substring matches, each in their original order. */
export function rankSuggestions(items: Suggestion[], typed: string, limit = 8): Suggestion[] {
  const q = typed.toLowerCase();
  if (q === '') return items.slice(0, limit);
  const starts: Suggestion[] = [];
  const contains: Suggestion[] = [];
  for (const item of items) {
    const v = item.value.toLowerCase();
    if (v === q) continue;
    if (v.startsWith(q)) starts.push(item);
    else if (v.includes(q)) contains.push(item);
  }
  return [...starts, ...contains].slice(0, limit);
}

export function wordAt(text: string, cursor: number): { start: number; word: string } {
  const before = text.slice(0, cursor);
  const m = /[$A-Za-z_][\w.$]*$/.exec(before);
  // Inside a string literal there is nothing to complete.
  const quotes = (before.match(/["']/g) ?? []).length;
  if (!m || quotes % 2 === 1) return { start: cursor, word: '' };
  return { start: cursor - m[0].length, word: m[0] };
}

export const EXPRESSION_VARIABLES: Record<string, string> = {
  event: 'the event being filtered: type, artifact, attributes, occurredAt',
  type: 'the event’s type (filters)',
  events: 'the batch’s events, oldest first',
  attributes: 'the event’s attributes (filters)',
  artifact: 'the event’s artifact: kind, id, url, version (filters)',
  process: 'the process: id, name',
  run: 'the run: id, status, externalUrl',
  mode: '"event" or "sweep"',
  now: 'the evaluation time, ISO-8601',
  result: 'what the destination returned (after-steps)',
};

export const EXPRESSION_FUNCTIONS: Suggestion[] = [
  { value: '$resolve(artifact)', hint: 'live', detail: 'The artifact as its system has it now' },
  { value: '$linked(artifact)', hint: 'live', detail: 'Artifacts linked to this one' },
  { value: '$now()', hint: 'time', detail: 'The evaluation time, ISO-8601' },
  { value: '$env("NAME")', hint: 'text', detail: 'An allowed environment variable' },
  {
    value: '$secretRef("provider/NAME")',
    hint: 'reference',
    detail: 'A reference the destination resolves after evaluation; never the value',
  },
  { value: '$count()', hint: 'number', detail: '$count(array): number of items' },
  { value: '$exists()', hint: 'boolean', detail: '$exists(value): true when it has a value' },
  { value: '$contains()', hint: 'boolean', detail: '$contains(text, part)' },
  { value: '$substring()', hint: 'text', detail: '$substring(text, start, length?)' },
  { value: '$lowercase()', hint: 'text', detail: '$lowercase(text)' },
  { value: '$uppercase()', hint: 'text', detail: '$uppercase(text)' },
  { value: '$string()', hint: 'text', detail: '$string(value)' },
  { value: '$number()', hint: 'number', detail: '$number(value)' },
  { value: '$join()', hint: 'text', detail: '$join(array, separator?)' },
  { value: '$split()', hint: 'array', detail: '$split(text, separator)' },
  { value: '$map()', hint: 'array', detail: '$map(array, function($v) { … })' },
  { value: '$filter()', hint: 'array', detail: '$filter(array, function($v) { … })' },
  { value: '$distinct()', hint: 'array', detail: '$distinct(array)' },
  { value: '$sum()', hint: 'number', detail: '$sum(array)' },
  { value: '$max()', hint: 'number', detail: '$max(array)' },
  { value: '$min()', hint: 'number', detail: '$min(array)' },
  { value: '$keys()', hint: 'array', detail: '$keys(object)' },
  { value: '$lookup()', hint: 'value', detail: '$lookup(object, key)' },
  { value: '$merge()', hint: 'object', detail: '$merge(array of objects)' },
  { value: '$toMillis()', hint: 'number', detail: '$toMillis(time)' },
  { value: '$fromMillis()', hint: 'time', detail: '$fromMillis(ms)' },
  { value: '$match()', hint: 'array', detail: '$match(text, /regex/)' },
];

export interface CompletionSources {
  /** Default: every one. */
  variables?: string[];
  /** Declared attribute names, offered as `attributes.<name>` (and under `event.`). */
  attributes?: { name: string; type?: string; description?: string }[];
  extra?: Suggestion[];
  /** Default true. Plugin expressions (a webhook mapping) run elsewhere and have only JSONata's. */
  switchboardFunctions?: boolean;
}

const SWITCHBOARD_FUNCTIONS = new Set(['$resolve', '$linked', '$env', '$secretRef']);

export function expressionCompletions(sources: CompletionSources = {}): Suggestion[] {
  const vars = sources.variables ?? Object.keys(EXPRESSION_VARIABLES);
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (s: Suggestion) => {
    if (seen.has(s.value)) return;
    seen.add(s.value);
    out.push(s);
  };
  for (const a of sources.attributes ?? []) {
    const hint = a.type ?? 'attribute';
    const detail = a.description;
    add({ value: `attributes.${a.name}`, hint, ...(detail ? { detail } : {}) });
    if (vars.includes('event'))
      add({ value: `event.attributes.${a.name}`, hint, ...(detail ? { detail } : {}) });
    if (vars.includes('events'))
      add({ value: `events.attributes.${a.name}`, hint, ...(detail ? { detail } : {}) });
  }
  for (const s of sources.extra ?? []) add(s);
  for (const v of vars) add({ value: v, hint: 'variable', detail: EXPRESSION_VARIABLES[v] ?? '' });
  const own = sources.switchboardFunctions ?? true;
  for (const f of EXPRESSION_FUNCTIONS) {
    if (!own && SWITCHBOARD_FUNCTIONS.has(f.value.replace(/\(.*$/, ''))) continue;
    add(f);
  }
  return out;
}
