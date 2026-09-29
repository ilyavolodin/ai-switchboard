import type { PluginContext } from './types/context.js';
import type { JSONSchema, Settings } from './types/common.js';
import { parseWith, type ParseWithOptions } from './schema/index.js';

/**
 * Wraps a type's `create` so it receives settings validated against `schema`, with defaults
 * applied. Invalid settings throw `Invalid <what>: <errors>`.
 */
export function withSettings<T, R>(
  schema: JSONSchema,
  what: string,
  create: (settings: T, ctx: PluginContext) => R,
  options: ParseWithOptions = {},
): (settings: Settings, ctx: PluginContext) => R {
  return (settings, ctx) => create(parseWith<T>(schema, settings, what, options), ctx);
}
