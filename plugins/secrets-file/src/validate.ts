import { validateAgainst, type JSONSchema } from '@ai-switchboard/sdk';

/** A settings, target or input value that does not match its schema. */
export class SchemaMismatchError extends Error {
  override readonly name = 'SchemaMismatchError';
}

/**
 * Validate a copy of `value` against `schema` and return the copy typed as `T`. The copy keeps
 * Ajv's `useDefaults` from mutating the caller's object while still applying schema defaults.
 */
export function parseWith<T>(schema: JSONSchema, value: unknown, what: string): T {
  const copy: unknown = value === undefined ? undefined : structuredClone(value);
  const check = validateAgainst(schema, copy);
  if (!check.valid) throw new SchemaMismatchError(`Invalid ${what}: ${check.errors.join('; ')}`);
  return copy as T;
}

/** Like `parseWith`, but returns `null` instead of throwing (for paths that must never throw). */
export function tryParse<T>(schema: JSONSchema, value: unknown): T | null {
  const copy: unknown = value === undefined ? undefined : structuredClone(value);
  return validateAgainst(schema, copy).valid ? (copy as T) : null;
}
