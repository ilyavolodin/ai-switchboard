import type { JSONSchema } from '@ai-switchboard/core/contract';
import {
  createAjv,
  xEffectiveDefaults,
  xEnumLabels,
  xGroup,
  xOrder,
  xSecret,
  xWarnings,
  xWidget,
  type XWidget,
} from '@ai-switchboard/sdk/schema';
import type { Ajv2020, ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';

export type ValuePath = (string | number)[];

export type FieldKind =
  'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'unknown';

/** How a field is edited: an `x-widget`, or what its type implies. */
export type Widget = XWidget | 'secret' | 'toggle' | 'number' | 'list' | 'text';

const TEXT_WIDGETS: readonly XWidget[] = [
  'cron',
  'expression',
  'path',
  'textarea',
  'code',
  'json',
  'password',
];

/**
 * A secret is always a reference picker; an enum is a select unless it asks for radios; `select`
 * also turns `examples` into choices. A text widget on a non-string field is ignored.
 */
export function pickWidget(s: JSONSchema, kind: FieldKind = fieldKind(s)): Widget {
  const widget = xWidget(s);
  if (isSecretField(s)) return 'secret';
  if (kind === 'enum') return widget === 'radio' ? 'radio' : 'select';
  if (widget === 'select' && Array.isArray(s.examples)) return 'select';
  if (kind === 'boolean') return 'toggle';
  if (kind === 'number' || kind === 'integer') return 'number';
  if (kind === 'array') return 'list';
  if (widget && TEXT_WIDGETS.includes(widget)) return widget;
  return 'text';
}

export function asSchema(v: unknown): JSONSchema | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JSONSchema) : null;
}

/** Enum wins over type; `["string","null"]` reads as string. */
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

/**
 * A nullable `anyOf` / `oneOf` (as zod and pydantic emit) reads as its one non-null option, with
 * the outer title, description and default kept. Validation still uses the full schema.
 */
export function fieldSchema(s: JSONSchema): JSONSchema {
  if (s.type !== undefined || s.enum !== undefined) return s;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const raw = s[key];
    if (!Array.isArray(raw)) continue;
    const options = (raw as unknown[]).map(asSchema);
    if (options.some((o) => o == null)) return s;
    const nonNull = options.filter((o): o is JSONSchema => o != null && o.type !== 'null');
    const only = nonNull[0];
    if (nonNull.length !== 1 || !only) return s;
    const { [key]: _options, ...outer } = s;
    return { ...only, ...outer };
  }
  return s;
}

/** Text that is not a number stays text, so validation names the problem. */
export function listItemValue(items: JSONSchema, text: string): string | number {
  const kind = fieldKind(items);
  if (kind !== 'number' && kind !== 'integer') return text;
  const n = Number(text);
  return text.trim() !== '' && Number.isFinite(n) ? n : text;
}

export function formatDefault(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.map(String).join(', ') : 'none';
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

export function textInputType(s: JSONSchema): 'password' | 'email' | 'url' | 'text' {
  if (xWidget(s) === 'password') return 'password';
  if (s.format === 'email') return 'email';
  if (s.format === 'uri') return 'url';
  return 'text';
}

/** From `x-enumLabels` (`{ "<value>": "<label>" }`); null falls back to the raw value. */
export function enumLabel(s: JSONSchema, option: unknown): string | null {
  return xEnumLabels(s)[String(option)] ?? null;
}

/** `x-order` first, then declaration order. */
export function orderedProperties(s: JSONSchema): [string, JSONSchema][] {
  const props = asSchema(s.properties) ?? {};
  const entries = Object.entries(props)
    .map(([k, v]) => [k, asSchema(v)] as const)
    .filter((e): e is [string, JSONSchema] => e[1] != null);
  const order = xOrder(s);
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e[0]) - rank(b.e[0]) || a.i - b.i)
    .map((x) => x.e);
}

/** In order of first appearance; ungrouped fields come first. */
export function groupProperties(
  props: [string, JSONSchema][],
): { group: string | null; fields: [string, JSONSchema][] }[] {
  const groups: { group: string | null; fields: [string, JSONSchema][] }[] = [];
  for (const entry of props) {
    const g = xGroup(entry[1]);
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

export function requiredOf(s: JSONSchema): string[] {
  return Array.isArray(s.required) ? (s.required as unknown[]).map(String) : [];
}

/** Stored as `secret://<provider>/<name>`, never shown. */
export function isSecretField(s: JSONSchema): boolean {
  return xSecret(s);
}

export function humanize(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function fieldTitle(key: string, s: JSONSchema): string {
  return typeof s.title === 'string' && s.title ? s.title : humanize(key);
}

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

export function getIn(value: unknown, path: ValuePath): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** `undefined` deletes object keys. */
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

export function pointer(path: ValuePath): string {
  return path.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

let ajv: Ajv2020 | null = null;
const compiled = new WeakMap<object, ValidateFunction | null>();

function validatorFor(schema: JSONSchema): ValidateFunction | null {
  if (compiled.has(schema)) return compiled.get(schema) ?? null;
  // No defaults: validating must not write into the form's value.
  ajv ??= createAjv({ useDefaults: false });
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

/** Messages keyed by JSON pointer; an empty object means valid. */
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

function mentioned(branch: JSONSchema | null): string[] {
  if (!branch) return [];
  return [...Object.keys(asSchema(branch.properties) ?? {}), ...requiredOf(branch)];
}

function matches(schema: JSONSchema | boolean, value: unknown): boolean {
  if (typeof schema === 'boolean') return schema;
  const validate = validatorFor(schema);
  return validate ? validate(value) : true;
}

export interface ResolvedObject {
  /** Top-level `required`, plus the active branches' and `dependentRequired`'s. */
  required: string[];
  /** Properties that belong only to branches that do not apply right now. */
  hidden: Set<string>;
}

/**
 * Resolves `if`/`then`/`else` (also inside `allOf`) and `dependentRequired`. A property a branch
 * names is shown only while a branch that names it applies; properties no branch names are always
 * shown.
 */
export function resolveConditionals(s: JSONSchema, value: unknown): ResolvedObject {
  const base = requiredOf(s);
  const required = new Set(base);
  const conditional = new Set<string>();
  const active = new Set<string>();
  const given =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  // Branches are decided on the value the plugin will actually get: unset fields take their
  // defaults (an `if` on a missing property would otherwise match every branch).
  const defaults = schemaDefaults(s);
  const obj: Record<string, unknown> = {
    ...(defaults !== null && typeof defaults === 'object'
      ? (defaults as Record<string, unknown>)
      : {}),
    ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)),
  };
  for (const [key, child] of orderedProperties(s)) {
    if (given[key] !== undefined) continue;
    const effective = effectiveDefault(child, given);
    if (effective !== undefined) obj[key] = effective;
  }
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
 * `x-effectiveDefault` (`[{ when?: <schema>, value }]`, matched against `parent`) is what the
 * plugin does while the field is unset. Unlike `default` it is only shown, never written into
 * settings, so a plugin can tell "unset" from a chosen value.
 */
export function effectiveDefault(s: JSONSchema, parent: unknown): unknown {
  for (const e of xEffectiveDefaults(s)) {
    if (e.when === undefined || matches(e.when, parent ?? {})) return e.value;
  }
  return 'default' in s ? s.default : undefined;
}

/** `x-warning`: `{ when: <schema>, message }` or a list of them; the first match wins. */
export function warningFor(s: JSONSchema, value: unknown): string | null {
  if (value === undefined) return null;
  return xWarnings(s).find((w) => matches(w.when, value))?.message ?? null;
}
