import {
  EXPRESSION_CONTEXTS,
  SWITCHBOARD_FUNCTIONS,
  type ContextField,
  type ExpressionContextKind,
} from '@ai-switchboard/core/expr-contexts';

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

/** JSONata's own functions; Switchboard's come from `SWITCHBOARD_FUNCTIONS`. */
const JSONATA_FUNCTIONS: Suggestion[] = [
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

const OWN_FUNCTIONS: Suggestion[] = SWITCHBOARD_FUNCTIONS.filter((f) => f.available).map((f) => ({
  value: f.signature,
  hint: 'switchboard',
  detail: f.description,
}));

/** Every field of a context as a dotted path, parents before their fields. */
export function contextPaths(fields: readonly ContextField[], prefix = ''): Suggestion[] {
  return fields.flatMap((f) => {
    const path = `${prefix}${f.name}`;
    return [
      { value: path, hint: f.type, detail: f.description },
      ...(f.fields ? contextPaths(f.fields, `${path}.`) : []),
    ];
  });
}

export interface CompletionSources {
  /** What the expression can read; `null` for none (a plugin's own expression). */
  context: ExpressionContextKind | null;
  /** Top-level names of the context that do not apply here (`result` in a `before` step). */
  without?: string[];
  /** Declared attribute names, offered as `attributes.<name>` (and under `event.`). */
  attributes?: { name: string; type?: string; description?: string }[];
  extra?: Suggestion[];
  /** Default true. Plugin expressions (a webhook mapping) run elsewhere and have only JSONata's. */
  switchboardFunctions?: boolean;
}

export function expressionCompletions(sources: CompletionSources): Suggestion[] {
  const fields = (sources.context ? EXPRESSION_CONTEXTS[sources.context] : []).filter(
    (f) => !sources.without?.includes(f.name),
  );
  const top = new Set(fields.map((f) => f.name));
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
    for (const parent of ['', 'event.', 'events.']) {
      if (top.has(parent === '' ? 'attributes' : parent.slice(0, -1)))
        add({ value: `${parent}attributes.${a.name}`, hint, ...(detail ? { detail } : {}) });
    }
  }
  for (const s of sources.extra ?? []) add(s);
  for (const s of contextPaths(fields)) add(s);
  if (sources.switchboardFunctions ?? true) for (const f of OWN_FUNCTIONS) add(f);
  for (const f of JSONATA_FUNCTIONS) add(f);
  return out;
}
