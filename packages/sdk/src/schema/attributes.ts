/** Browser-safe builders for an event type's flat `attributes` schema. */
import type { JSONSchema } from '../types/common.js';

export const attr = {
  string: (description: string): JSONSchema => ({ type: 'string', description }),
  integer: (description: string): JSONSchema => ({ type: 'integer', description }),
  number: (description: string): JSONSchema => ({ type: 'number', description }),
  boolean: (description: string): JSONSchema => ({ type: 'boolean', description }),
  strings: (description: string): JSONSchema => ({
    type: 'array',
    items: { type: 'string' },
    description,
  }),
} as const;

/** A closed object schema; `required` defaults to every property. */
export function flatAttributesSchema(
  properties: Record<string, JSONSchema>,
  required: readonly string[] = Object.keys(properties),
): JSONSchema {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}
