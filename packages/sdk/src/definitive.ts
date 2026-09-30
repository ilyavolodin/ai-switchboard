import { InvokeError } from './errors.js';
import { parseWith, SchemaMismatchError } from './schema/index.js';
import type { JSONSchema } from './types/common.js';

/**
 * `parseWith` for a destination's target or input inside `invoke`: a value that does not match
 * throws a definitive `InvokeError`, since retrying cannot fix it.
 */
export function parseDefinitive<T>(schema: JSONSchema, value: unknown, what: string): T {
  try {
    return parseWith<T>(schema, value, what);
  } catch (err) {
    if (err instanceof SchemaMismatchError) {
      throw new InvokeError(err.message, { definitive: true, cause: err });
    }
    throw err;
  }
}
