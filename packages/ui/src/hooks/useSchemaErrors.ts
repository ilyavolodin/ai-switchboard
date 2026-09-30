import type { JSONSchema } from '@ai-switchboard/core/contract';
import { useMemo } from 'react';

import { validateAgainstSchema } from '../lib/schema.js';

/** Messages keyed by JSON pointer; pass the result to `<SchemaForm errors>` so it validates once. */
export function useSchemaErrors(schema: JSONSchema, value: unknown): Record<string, string[]> {
  return useMemo(() => validateAgainstSchema(schema, value), [schema, value]);
}
