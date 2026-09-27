/**
 * JSON Schema (draft 2020-12) helpers for `SchemaForm`: reading the UI annotations plugins use
 * (`x-secret`, `x-widget`, `x-group`, `x-order`, `x-placeholder`, `x-help`), defaults, immutable
 * path updates, secret references and client-side validation with Ajv.
 */
import type { JSONSchema } from '@ai-switchboard/core/contract';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

// ajv-formats ships CJS with a default export that ESM sees as a namespace.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

/** A path into a value: object keys and array indexes. */
export type ValuePath = (string | number)[];

/** The field kinds SchemaForm renders. */
export type FieldKind =
  'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'unknown';

/** Narrows an unknown to a schema object. */
export function asSchema(v: unknown): JSONSchema | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JSONSchema) : null;
}

/** The kind of a schema: enum wins over type; `["string","null"]` reads as string. */
export function fieldKind(s: JSONSchema): FieldKind {
  if (Array.isArray(s.enum)) return 'enum';
  const t = Array.isArray(s.type) ? (s.type as unknown[]).find((x) => x !== 'null') : s.type;
  switch (t) {
    case 'object':
    case 'array':
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      return t;
    default:
      return s.properties ? 'object' : 'unknown';
  }
}

/** `properties` as an ordered list: `x-order` first, then declaration order. */
export function orderedProperties(s: JSONSchema): [string, JSONSchema][] {
  const props = asSchema(s.properties) ?? {};
  const entries = Object.entries(props)
    .map(([k, v]) => [k, asSchema(v)] as const)
    .filter((e): e is [string, JSONSchema] => e[1] != null);
  const order = Array.isArray(s['x-order']) ? (s['x-order'] as unknown[]).map(String) : [];
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e[0]) - rank(b.e[0]) || a.i - b.i)
    .map((x) => x.e);
}

/** Groups properties by `x-group`, in order of first appearance; ungrouped fields come first. */
export function groupProperties(
  props: [string, JSONSchema][],
): { group: string | null; fields: [string, JSONSchema][] }[] {
  const groups: { group: string | null; fields: [string, JSONSchema][] }[] = [];
  for (const entry of props) {
    const raw = entry[1]['x-group'];
    const g = typeof raw === 'string' ? raw : null;
    let bucket = groups.find((x) => x.group === g);
    if (!bucket) {
      bucket = { group: g, fields: [] };
      if (g == null) groups.unshift(bucket);
      else groups.push(bucket);
    }
    bucket.fields.push(entry);
  }
  return groups;
}

/** The required property names of an object schema. */
export function requiredOf(s: JSONSchema): string[] {
  return Array.isArray(s.required) ? (s.required as unknown[]).map(String) : [];
}

/** True for `x-secret: true` fields: stored as `secret://<provider>/<name>`, never shown. */
export function isSecretField(s: JSONSchema): boolean {
  return s['x-secret'] === true;
}

/** "pollIntervalSeconds" → "Poll interval seconds"; "api_key" → "Api key". */
export function humanize(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The label of a field: its `title`, else the humanized key. */
export function fieldTitle(key: string, s: JSONSchema): string {
  return typeof s.title === 'string' && s.title ? s.title : humanize(key);
}

const SECRET_RE = /^secret:\/\/([^/]+)\/(.+)$/;

/** Parses `secret://env/NAME`; `null` for anything else. */
export function parseSecretRef(v: unknown): { provider: string; name: string } | null {
  if (typeof v !== 'string') return null;
  const m = SECRET_RE.exec(v);
  return m ? { provider: m[1] ?? '', name: m[2] ?? '' } : null;
}

/** Builds `secret://<provider>/<name>`. */
export function formatSecretRef(provider: string, name: string): string {
  return `secret://${provider}/${name}`;
}

/** An initial value from `default`s (objects recurse; arrays and scalars take their default). */
export function schemaDefaults(s: JSONSchema): unknown {
  if ('default' in s) return structuredClone(s.default);
  if (fieldKind(s) === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, child] of orderedProperties(s)) {
      const d = schemaDefaults(child);
      if (d !== undefined) out[k] = d;
    }
    return out;
  }
  return undefined;
}

/** Reads a nested value. */
export function getIn(value: unknown, path: ValuePath): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** Returns a copy of `value` with `path` set (`undefined` deletes object keys). */
export function setIn(value: unknown, path: ValuePath, next: unknown): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path as [string | number, ...ValuePath];
  if (typeof head === 'number') {
    const arr = Array.isArray(value) ? [...(value as unknown[])] : [];
    arr[head] = setIn(arr[head], rest, next);
    return arr;
  }
  const obj: Record<string, unknown> =
    value != null && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  const child = setIn(obj[head], rest, next);
  if (child !== undefined) return { ...obj, [head]: child };
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== head));
}

/** A JSON pointer for a path ("/repositories/0/name"). */
export function pointer(path: ValuePath): string {
  return path.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

let ajv: Ajv2020 | null = null;
const compiled = new WeakMap<object, ValidateFunction | null>();

function validatorFor(schema: JSONSchema): ValidateFunction | null {
  if (compiled.has(schema)) return compiled.get(schema) ?? null;
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: false });
    addFormats(ajv);
  }
  const fn = compileOrNull(ajv, schema);
  compiled.set(schema, fn);
  return fn;
}

function compileOrNull(instance: Ajv2020, schema: JSONSchema): ValidateFunction | null {
  try {
    return instance.compile(schema);
  } catch {
    // A schema Ajv cannot compile is the plugin's bug; the server validates on save anyway.
    return null;
  }
}

function friendly(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case 'required':
      return 'Required';
    case 'minLength':
      return `Use at least ${String(p.limit)} character${p.limit === 1 ? '' : 's'}`;
    case 'maxLength':
      return `Use at most ${String(p.limit)} characters`;
    case 'minimum':
      return `Must be at least ${String(p.limit)}`;
    case 'maximum':
      return `Must be at most ${String(p.limit)}`;
    case 'exclusiveMinimum':
      return `Must be more than ${String(p.limit)}`;
    case 'exclusiveMaximum':
      return `Must be less than ${String(p.limit)}`;
    case 'type':
      return p.type === 'integer' ? 'Must be a whole number' : `Must be a ${String(p.type)}`;
    case 'format':
      return `Must be a valid ${String(p.format)}`;
    case 'pattern':
      return 'Does not match the expected format';
    case 'enum':
      return 'Choose one of the options';
    case 'minItems':
      return `Add at least ${String(p.limit)}`;
    case 'maxItems':
      return `At most ${String(p.limit)} allowed`;
    default: {
      const m = e.message ?? 'Invalid value';
      return m.charAt(0).toUpperCase() + m.slice(1);
    }
  }
}

/**
 * Validates `value` against `schema`; returns messages keyed by JSON pointer (`/team`,
 * `/repositories/0/name`). Empty object = valid.
 */
export function validateAgainstSchema(
  schema: JSONSchema,
  value: unknown,
): Record<string, string[]> {
  const validate = validatorFor(schema);
  if (!validate) return {};
  if (validate(value)) return {};
  const out: Record<string, string[]> = {};
  for (const e of validate.errors ?? []) {
    const missing =
      e.keyword === 'required'
        ? (e.params as { missingProperty?: string }).missingProperty
        : undefined;
    const at = missing ? `${e.instancePath}/${missing}` : e.instancePath;
    const list = out[at] ?? [];
    const msg = friendly(e);
    if (!list.includes(msg)) list.push(msg);
    out[at] = list;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Conditionals: `if`/`then`/`else` (also inside `allOf`) and `dependentRequired`
// ---------------------------------------------------------------------------------------------

interface Conditional {
  if: JSONSchema | boolean;
  then: JSONSchema | null;
  else: JSONSchema | null;
}

function conditionalsOf(s: JSONSchema): Conditional[] {
  const out: Conditional[] = [];
  const collect = (node: JSONSchema) => {
    const cond = node.if;
    if (typeof cond === 'boolean' || asSchema(cond)) {
      out.push({
        if: typeof cond === 'boolean' ? cond : (asSchema(cond) ?? {}),
        then: asSchema(node.then),
        else: asSchema(node.else),
      });
    }
    if (Array.isArray(node.allOf))
      for (const part of node.allOf as unknown[]) {
        const sub = asSchema(part);
        if (sub) collect(sub);
      }
  };
  collect(s);
  return out;
}

/** Property names a branch talks about: its `properties` and its `required`. */
function mentioned(branch: JSONSchema | null): string[] {
  if (!branch) return [];
  return [...Object.keys(asSchema(branch.properties) ?? {}), ...requiredOf(branch)];
}

function matches(schema: JSONSchema | boolean, value: unknown): boolean {
  if (typeof schema === 'boolean') return schema;
  const validate = validatorFor(schema);
  return validate ? validate(value) : true;
}

/** What an object schema's conditionals mean for the form, given the current value. */
export interface ResolvedObject {
  /** Top-level `required`, plus the active branches' and `dependentRequired`'s. */
  required: string[];
  /** Properties that belong only to branches that do not apply right now. */
  hidden: Set<string>;
}

/**
 * Resolves `if`/`then`/`else` (at the top level and inside `allOf`) and `dependentRequired`
 * against the current value. A property named by a branch (in its `properties` or `required`)
 * is conditional: it is shown only while a branch that names it applies. Properties no branch
 * names are always shown. So `verification: none` hides the webhook's secret and header fields.
 */
export function resolveConditionals(s: JSONSchema, value: unknown): ResolvedObject {
  const base = requiredOf(s);
  const required = new Set(base);
  const conditional = new Set<string>();
  const active = new Set<string>();
  const obj =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  for (const c of conditionalsOf(s)) {
    for (const k of [...mentioned(c.then), ...mentioned(c.else)]) conditional.add(k);
    const branch = matches(c.if, obj) ? c.then : c.else;
    for (const k of mentioned(branch)) active.add(k);
    for (const k of requiredOf(branch ?? {})) required.add(k);
  }
  const dependent = asSchema(s.dependentRequired);
  if (dependent) {
    for (const [key, list] of Object.entries(dependent)) {
      if (obj[key] === undefined || !Array.isArray(list)) continue;
      for (const k of list as unknown[]) required.add(String(k));
    }
  }
  const hidden = new Set<string>();
  for (const k of conditional) if (!active.has(k) && !base.includes(k)) hidden.add(k);
  return { required: [...required], hidden };
}

/**
 * The `x-warning` annotation: `{ when: <schema>, message }` (or a list of them). Returns the
 * message of the first entry whose `when` matches the value, else `null`.
 */
export function warningFor(s: JSONSchema, value: unknown): string | null {
  const raw = s['x-warning'];
  const list = Array.isArray(raw) ? (raw as unknown[]) : raw === undefined ? [] : [raw];
  for (const entry of list) {
    const w = asSchema(entry);
    if (!w || typeof w.message !== 'string') continue;
    const when = typeof w.when === 'boolean' ? w.when : asSchema(w.when);
    if (when === null) continue;
    if (value !== undefined && matches(when, value)) return w.message;
  }
  return null;
}
