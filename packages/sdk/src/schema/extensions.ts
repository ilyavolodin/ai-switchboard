import { asObject } from '../json.js';
import type { JSONSchema } from '../types/common.js';

/** The `x-*` keywords a settings, target or input schema may carry to steer the UI form. */
export const UI_KEYWORDS = [
  'x-secret',
  'x-widget',
  'x-group',
  'x-order',
  'x-placeholder',
  'x-help',
  'x-warning',
  'x-enumLabels',
  'x-effectiveDefault',
  'x-docs',
] as const;
export type UiKeyword = (typeof UI_KEYWORDS)[number];

/** `password` is a masked text input; `select` turns `examples` into a pick list. */
export const X_WIDGETS = [
  'expression',
  'textarea',
  'code',
  'json',
  'path',
  'cron',
  'radio',
  'select',
  'password',
] as const;
export type XWidget = (typeof X_WIDGETS)[number];

export interface XWarning {
  /** Shown while the field's value matches this schema. */
  when: JSONSchema | boolean;
  message: string;
}

export interface XEffectiveDefault {
  /** Matched against the parent object; omitted means always. */
  when?: JSONSchema | boolean;
  value: unknown;
}

export interface XDocs {
  url: string;
  label?: string;
}

export interface SchemaUiExtensions {
  /** The field holds a `secret://<provider>/<name>` reference, never a value. */
  'x-secret'?: boolean;
  'x-widget'?: XWidget;
  'x-group'?: string;
  'x-order'?: string[];
  'x-placeholder'?: string;
  'x-help'?: string;
  /** The first match wins. */
  'x-warning'?: XWarning | XWarning[];
  /** `{ "<enum value>": "<label>" }`. */
  'x-enumLabels'?: Record<string, string>;
  /** What the plugin does while the field is unset; shown, never stored. The first match wins. */
  'x-effectiveDefault'?: XEffectiveDefault[];
  'x-docs'?: XDocs;
}

function asCondition(v: unknown): JSONSchema | boolean | null {
  return typeof v === 'boolean' ? v : (asObject(v) ?? null);
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export function isXWidget(value: unknown): value is XWidget {
  return typeof value === 'string' && (X_WIDGETS as readonly string[]).includes(value);
}

export function xSecret(s: JSONSchema): boolean {
  return s['x-secret'] === true;
}

/** Null for a missing or unknown widget: the form picks the control from the type. */
export function xWidget(s: JSONSchema): XWidget | null {
  const w = s['x-widget'];
  return isXWidget(w) ? w : null;
}

export function xGroup(s: JSONSchema): string | null {
  return nonEmptyString(s['x-group']);
}

export function xOrder(s: JSONSchema): string[] {
  const raw = s['x-order'];
  return Array.isArray(raw) ? raw.map(String) : [];
}

export function xPlaceholder(s: JSONSchema): string | null {
  return nonEmptyString(s['x-placeholder']);
}

export function xHelp(s: JSONSchema): string | null {
  return nonEmptyString(s['x-help']);
}

/** Entries without a string `message` or a usable `when` are dropped. */
export function xWarnings(s: JSONSchema): XWarning[] {
  const raw = s['x-warning'];
  const list: unknown[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out: XWarning[] = [];
  for (const entry of list) {
    const w = asObject(entry);
    if (!w || typeof w.message !== 'string') continue;
    const when = asCondition(w.when);
    if (when === null) continue;
    out.push({ when, message: w.message });
  }
  return out;
}

export function xEnumLabels(s: JSONSchema): Record<string, string> {
  const labels = asObject(s['x-enumLabels']);
  const out: Record<string, string> = {};
  if (!labels) return out;
  for (const [k, v] of Object.entries(labels)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Entries without `value`, or with a `when` that is not a schema, are dropped. */
export function xEffectiveDefaults(s: JSONSchema): XEffectiveDefault[] {
  const raw = s['x-effectiveDefault'];
  if (!Array.isArray(raw)) return [];
  const out: XEffectiveDefault[] = [];
  for (const entry of raw) {
    const e = asObject(entry);
    if (!e || !('value' in e)) continue;
    if (e.when === undefined) {
      out.push({ value: e.value });
      continue;
    }
    const when = asCondition(e.when);
    if (when !== null) out.push({ when, value: e.value });
  }
  return out;
}

/** Only `http(s)` links; the label defaults to "Documentation". */
export function xDocs(s: JSONSchema): { url: string; label: string } | null {
  const d = asObject(s['x-docs']);
  if (!d || typeof d.url !== 'string' || !/^https?:\/\//.test(d.url)) return null;
  return { url: d.url, label: typeof d.label === 'string' ? d.label : 'Documentation' };
}
