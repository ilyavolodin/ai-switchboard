import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import type { JSONSchema } from '../types/common.js';

import { UI_KEYWORDS } from './extensions.js';

// ajv-formats ships CJS with a default export that ESM sees as a namespace.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

export interface CreateAjvOptions {
  /**
   * Fill in schema defaults while validating (the default). Validation then mutates the value, so
   * turn it off to validate a value that must stay as it is, such as form state.
   */
  useDefaults?: boolean;
}

export function createAjv(options: CreateAjvOptions = {}): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    useDefaults: options.useDefaults ?? true,
    coerceTypes: false,
  });
  addFormats(ajv);
  for (const keyword of UI_KEYWORDS)
    ajv.addKeyword({ keyword, schemaType: ['boolean', 'string', 'number', 'object', 'array'] });
  return ajv;
}

const shared = createAjv();
const cache = new WeakMap<object, ValidateFunction>();

/** Cached per schema object. Throws when the schema is invalid. */
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

/** Returns messages like `/label must be string`. */
export function validateAgainst(schema: JSONSchema, value: unknown): SchemaCheck {
  const fn = compileSchema(schema);
  const valid = fn(value);
  return { valid, errors: valid ? [] : formatErrors(fn.errors) };
}

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

/** A settings, target or input value that does not match its schema. */
export class SchemaMismatchError extends Error {
  override readonly name = 'SchemaMismatchError';
}

export interface ParseWithOptions {
  /** Defaults to `SchemaMismatchError`. */
  error?: new (message: string) => Error;
}

function validatedCopy(schema: JSONSchema, value: unknown): { copy: unknown; check: SchemaCheck } {
  const copy: unknown = value === undefined ? undefined : structuredClone(value);
  return { copy, check: validateAgainst(schema, copy) };
}

/**
 * Validates a copy with the schema's defaults applied, so Ajv's `useDefaults` never mutates the
 * caller's object. Throws `Invalid <what>: <errors>`.
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

/** Like `parseWith`, but returns `null` instead of throwing. */
export function tryParse<T>(schema: JSONSchema, value: unknown): T | null {
  const { copy, check } = validatedCopy(schema, value);
  return check.valid ? (copy as T) : null;
}
