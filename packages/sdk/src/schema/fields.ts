import type { JSONSchema } from '../types/common.js';

import { isRecord } from '../json.js';

import { xSecret } from './extensions.js';

export interface SchemaField {
  /** Dotted, e.g. `auth.token`. */
  path: string;
  schema: JSONSchema;
}

/** Every property under `properties`, nested objects included whether or not they declare a type. */
export function schemaFields(schema: JSONSchema, prefix = ''): SchemaField[] {
  const props = schema.properties;
  if (!isRecord(props)) return [];
  return Object.entries(props).flatMap(([key, sub]) => {
    if (!isRecord(sub)) return [];
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return [{ path, schema: sub }, ...schemaFields(sub, path)];
  });
}

/** Dotted paths of properties marked `x-secret: true`, including in nested objects. */
export function secretPaths(schema: JSONSchema, prefix = ''): string[] {
  return schemaFields(schema, prefix)
    .filter((field) => xSecret(field.schema))
    .map((field) => field.path);
}
