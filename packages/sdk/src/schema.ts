import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import type { JSONSchema } from './types/common.js';

// ajv-formats ships CJS with a default export that ESM sees as a namespace.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

/** UI annotation keywords plugin schemas may use. */
export const UI_KEYWORDS = [
  'x-secret',
  'x-widget',
  'x-group',
  'x-order',
  'x-placeholder',
  'x-help',
  'x-warning',
  'x-enumLabels',
] as const;

/** An Ajv instance for draft 2020-12 with formats and Switchboard's UI annotations registered. */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    useDefaults: true,
    coerceTypes: false,
  });
  addFormats(ajv);
  for (const keyword of UI_KEYWORDS)
    ajv.addKeyword({ keyword, schemaType: ['boolean', 'string', 'number', 'object', 'array'] });
  return ajv;
}

const shared = createAjv();
const cache = new WeakMap<object, ValidateFunction>();

/** Compile (cached per schema object) and return a validator. Throws when the schema is invalid. */
export function compileSchema(schema: JSONSchema): ValidateFunction {
  let fn = cache.get(schema);
  if (!fn) {
    fn = shared.compile(schema);
    cache.set(schema, fn);
  }
  return fn;
}

export interface SchemaCheck {
  valid: boolean;
  errors: string[];
}

export function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(
    (e) => `${e.instancePath === '' ? '(root)' : e.instancePath} ${e.message ?? 'is invalid'}`,
  );
}

/** Validate `value` against `schema`. Returns messages like `/label must be string`. */
export function validateAgainst(schema: JSONSchema, value: unknown): SchemaCheck {
  const fn = compileSchema(schema);
  const valid = fn(value);
  return { valid, errors: valid ? [] : formatErrors(fn.errors) };
}

/** True when `schema` itself is a well-formed JSON Schema. */
export function isValidSchema(schema: unknown): SchemaCheck {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { valid: false, errors: ['schema must be an object'] };
  }
  try {
    createAjv().compile(schema as JSONSchema);
    return { valid: true, errors: [] };
  } catch (err) {
    return { valid: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

/** Property names marked `x-secret: true` at the top level of an object schema (and nested objects). */
export function secretPaths(schema: JSONSchema, prefix = ''): string[] {
  const props = schema.properties as Record<string, JSONSchema> | undefined;
  if (!props) return [];
  const out: string[] = [];
  for (const [key, sub] of Object.entries(props)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (sub['x-secret'] === true) out.push(path);
    if (sub.type === 'object') out.push(...secretPaths(sub, path));
  }
  return out;
}

/** A settings, target or input value that does not match its schema. */
export class SchemaMismatchError extends Error {
  override readonly name = 'SchemaMismatchError';
}

/** Options for `parseWith`. */
export interface ParseWithOptions {
  /** The error class to throw on a mismatch. Defaults to `SchemaMismatchError`. */
  error?: new (message: string) => Error;
}

function validatedCopy(schema: JSONSchema, value: unknown): { copy: unknown; check: SchemaCheck } {
  const copy: unknown = value === undefined ? undefined : structuredClone(value);
  return { copy, check: validateAgainst(schema, copy) };
}

/**
 * Validate a copy of `value` against `schema` and return the copy, with the schema's defaults
 * applied, typed as `T`. Working on a copy keeps Ajv's `useDefaults` from mutating the caller's
 * object. Throws `Invalid <what>: <errors>` (a `SchemaMismatchError` unless `options.error` names
 * another class). Use it for settings in `create()` and for targets and inputs in `invoke()`.
 */
export function parseWith<T>(
  schema: JSONSchema,
  value: unknown,
  what: string,
  options: ParseWithOptions = {},
): T {
  const { copy, check } = validatedCopy(schema, value);
  if (!check.valid) {
    const ErrorClass = options.error ?? SchemaMismatchError;
    throw new ErrorClass(`Invalid ${what}: ${check.errors.join('; ')}`);
  }
  return copy as T;
}

/** Like `parseWith`, but returns `null` instead of throwing (for paths that must never throw). */
export function tryParse<T>(schema: JSONSchema, value: unknown): T | null {
  const { copy, check } = validatedCopy(schema, value);
  return check.valid ? (copy as T) : null;
}
