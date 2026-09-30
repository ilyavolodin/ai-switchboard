import { secretPaths, validateAgainst, type JSONSchema } from '@ai-switchboard/sdk';

import { destinationCapsSchema } from '../contract/destinations.js';
import { sourceCapsSchema } from '../contract/sources.js';
import { acceptsUnauthenticated } from '../domain/authentication.js';
import type { InstanceKind } from '../domain/status.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import { literalSecretFields } from '../secrets/refs.js';
import { badRequest, unprocessable } from './errors.js';
import type { PluginAdminPort } from '../plugins/admin-port.js';

export interface InstanceTypeInfo {
  displayName: string;
  icon?: string | undefined;
  settingsSchema: JSONSchema;
}

export function instanceType(
  runtime: PluginRuntime,
  kind: InstanceKind,
  typeId: string,
): InstanceTypeInfo | undefined {
  switch (kind) {
    case 'source':
      return runtime.sourceType(typeId)?.type;
    case 'destination':
      return runtime.destinationType(typeId)?.type;
    case 'notifier':
      return runtime.notifierType(typeId)?.type;
    case 'secret_provider':
      return runtime.secretProviderType(typeId)?.type;
  }
}

export function kindLabel(kind: string): string {
  return kind.replace('_', ' ');
}

const relaxedCache = new WeakMap<JSONSchema, JSONSchema>();

const KEPT_SECRET_KEYWORDS = [
  'title',
  'description',
  'x-group',
  'x-widget',
  'x-order',
  'x-help',
  'x-placeholder',
];

/**
 * Stored settings hold `secret://` references in `x-secret` fields, so a secret field's
 * format/pattern cannot be checked here; the plugin's `create()` validates the resolved value.
 */
export function referenceTolerantSchema(schema: JSONSchema): JSONSchema {
  const cached = relaxedCache.get(schema);
  if (cached) return cached;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    if (obj['x-secret'] === true) {
      const relaxed: Record<string, unknown> = { type: 'string', 'x-secret': true };
      for (const k of KEPT_SECRET_KEYWORDS) if (k in obj) relaxed[k] = obj[k];
      return relaxed;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
    return out;
  };
  const relaxed = walk(schema) as JSONSchema;
  relaxedCache.set(schema, relaxed);
  return relaxed;
}

/** Validate plugin settings against the type's schema; refuse literal values in secret fields. */
export function validateSettings(
  schema: JSONSchema,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const copy = structuredClone(settings);
  const check = validateAgainst(referenceTolerantSchema(schema), copy);
  if (!check.valid) throw badRequest('Settings do not match the plugin schema.', check.errors);
  const literals = literalSecretFields(secretPaths(schema), copy);
  if (literals.length > 0) {
    throw badRequest(
      'Secret fields must hold a secret:// reference, never a value.',
      literals.map((p) => `${p} must be a secret://<provider>/<name> reference`),
    );
  }
  return copy;
}

/**
 * Without the plugin its schema (and so its secret fields) is unknown: new settings cannot be
 * checked for literal secret values, so they are refused until the plugin is back.
 */
export function checkableSchema(type: InstanceTypeInfo | undefined): JSONSchema {
  if (!type)
    throw unprocessable(
      'The plugin for this instance is unavailable, so its settings cannot be checked. Reinstall the plugin first.',
    );
  return type.settingsSchema;
}

export function capsSchemaFor(kind: InstanceKind): JSONSchema | undefined {
  if (kind === 'source') return sourceCapsSchema;
  if (kind === 'destination') return destinationCapsSchema;
  return undefined;
}

export function validateCaps(kind: InstanceKind, caps: unknown): Record<string, unknown> {
  const schema = capsSchemaFor(kind);
  if (!schema) return {};
  const copy = structuredClone(caps ?? {}) as Record<string, unknown>;
  const check = validateAgainst(schema, copy);
  if (!check.valid) throw badRequest('Caps are invalid.', check.errors);
  return copy;
}

const PROVIDER_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function instanceName(kind: InstanceKind, name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') throw badRequest('A name is required.');
  const n = name.trim().slice(0, 120);
  if (kind === 'secret_provider' && !PROVIDER_NAME.test(n)) {
    throw badRequest(
      'A secret provider name is the <provider> in secret://<provider>/<name>: lower-case letters, digits and dashes.',
    );
  }
  return n;
}

export type SourceProbe = PluginAdminPort['buildPreviewSource'];

/**
 * A push instance must verify deliveries. Only a type that allows it (the generic webhook) may
 * build one without `verify`, and `caps.unauthenticated` is derived from an instance built from
 * these settings, whatever the request said. When nothing can be built (plugin missing, a secret
 * that does not resolve) the previous flag is kept.
 */
export async function sourceAuthCaps(
  runtime: PluginRuntime,
  probe: SourceProbe,
  source: { id: string; typeId: string; name: string; settings: Record<string, unknown> },
  caps: Record<string, unknown>,
  previous: boolean,
): Promise<Record<string, unknown>> {
  const { unauthenticated: _requested, ...rest } = caps;
  const keep = previous ? { ...rest, unauthenticated: true } : rest;
  const type = runtime.sourceType(source.typeId)?.type;
  if (!type) return keep;
  if (type.mode === 'pull') return rest;
  const built = await probe(source.typeId, source.settings, source.id, source.name);
  if (!built.ok) return keep;
  if (typeof built.live.source.verify === 'function') return rest;
  if (!acceptsUnauthenticated(type, built.live.source))
    throw unprocessable(
      `${type.displayName} sources must verify deliveries: configure verification in the settings.`,
    );
  return { ...rest, unauthenticated: true };
}
