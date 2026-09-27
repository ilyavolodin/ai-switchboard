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
