import { iconProblem } from './icons.js';
import { isValidSchema, validateAgainst } from './schema.js';
import type { Capabilities, JSONSchema } from './types/common.js';
import type { DestinationType } from './types/destination.js';
import type { NotifierType, SecretProviderType } from './types/notifier.js';
import type { SourceType } from './types/source.js';
import { SDK_MAJOR, SDK_VERSION } from './version.js';

export interface PluginSpec {
  /** Globally unique, kebab-case. */
  id: string;
  displayName: string;
  description?: string;
  sources?: SourceType[];
  destinations?: DestinationType[];
  notifiers?: NotifierType[];
  secretProviders?: SecretProviderType[];
  capabilities?: Capabilities;
}

export interface PluginDefinition extends Required<Omit<PluginSpec, 'description'>> {
  description?: string;
  /** The SDK the plugin was built against; the plugin host checks the major. */
  readonly switchboardSdk: { major: number; version: string };
}

export type PluginKind = 'source' | 'destination' | 'notifier' | 'secret_provider';

export function definePlugin(spec: PluginSpec): PluginDefinition {
  return Object.freeze({
    id: spec.id,
    displayName: spec.displayName,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    sources: spec.sources ?? [],
    destinations: spec.destinations ?? [],
    notifiers: spec.notifiers ?? [],
    secretProviders: spec.secretProviders ?? [],
    capabilities: spec.capabilities ?? {},
    switchboardSdk: { major: SDK_MAJOR, version: SDK_VERSION },
  });
}

export function isPluginDefinition(value: unknown): value is PluginDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'switchboardSdk' in value &&
    'id' in value &&
    typeof (value as { id: unknown }).id === 'string'
  );
}

export const MAX_INVOKE_TIMEOUT_SECONDS = 3600;

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const EVENT_TYPE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9_-]*)+$/;
const FLAT_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

function checkSchema(errors: string[], where: string, schema: JSONSchema | undefined): void {
  if (schema === undefined) {
    errors.push(`${where}: schema is missing`);
    return;
  }
  const check = isValidSchema(schema);
  if (!check.valid) errors.push(`${where}: invalid JSON Schema: ${check.errors.join('; ')}`);
}

function checkFlatAttributes(errors: string[], where: string, schema: JSONSchema): void {
  if (schema.type !== 'object') {
    errors.push(`${where}: attributes schema must be type "object"`);
    return;
  }
  const props = (schema.properties ?? {}) as Record<string, JSONSchema>;
  for (const [key, prop] of Object.entries(props)) {
    const t = prop.type;
    const flat =
      (typeof t === 'string' && FLAT_TYPES.has(t)) ||
      (t === 'array' && (prop.items as JSONSchema | undefined)?.type === 'string');
    if (!flat) errors.push(`${where}: attribute "${key}" must be a scalar or an array of strings`);
  }
}

/** Returns an empty array when the plugin is valid. */
export function validatePlugin(plugin: PluginDefinition): string[] {
  const errors: string[] = [];
  if (!KEBAB.test(plugin.id)) errors.push(`plugin id "${plugin.id}" must be kebab-case`);
  if (plugin.displayName.trim() === '') errors.push('plugin displayName is required');

  const seen = new Set<string>();
  const checkIcon = (where: string, icon: string | undefined): void => {
    if (icon === undefined) return;
    const problem = iconProblem(icon);
    if (problem !== null) errors.push(`${where}: ${problem}`);
  };
  const unique = (kind: PluginKind, id: string): void => {
    if (!KEBAB.test(id)) errors.push(`${kind} "${id}": id must be kebab-case`);
    const key = `${kind}:${id}`;
    if (seen.has(key)) errors.push(`${kind} "${id}": duplicate id`);
    seen.add(key);
  };

  for (const s of plugin.sources) {
    unique('source', s.id);
    checkIcon(`source ${s.id}`, s.icon);
    checkSchema(errors, `source ${s.id} settingsSchema`, s.settingsSchema);
    if (!['push', 'pull', 'both'].includes(s.mode)) errors.push(`source ${s.id}: invalid mode`);
    const types = new Set<string>();
    for (const et of s.eventTypes) {
      const where = `source ${s.id} event ${et.type}`;
      if (!EVENT_TYPE.test(et.type))
        errors.push(`${where}: type must look like "<source>.<object>.<verb>"`);
      if (!s.dynamicEventTypes && !et.type.startsWith(`${s.id}.`)) {
        errors.push(`${where}: type must start with "${s.id}."`);
      }
      if (types.has(et.type)) errors.push(`${where}: duplicate event type`);
      types.add(et.type);
      checkSchema(errors, `${where} attributes`, et.attributes);
      checkFlatAttributes(errors, where, et.attributes);
      if (et.examples.length === 0) errors.push(`${where}: at least one example is required`);
      for (const [i, ex] of et.examples.entries()) {
        const check = validateAgainst(et.attributes, ex);
        if (!check.valid) errors.push(`${where}: example ${i} invalid: ${check.errors.join('; ')}`);
      }
    }
    for (const a of s.actions ?? [])
      checkSchema(errors, `source ${s.id} action ${a.id} argsSchema`, a.argsSchema);
  }

  for (const e of plugin.destinations) {
    unique('destination', e.id);
    checkIcon(`destination ${e.id}`, e.icon);
    if (
      e.invokeTimeoutSeconds !== undefined &&
      !(
        typeof e.invokeTimeoutSeconds === 'number' &&
        Number.isFinite(e.invokeTimeoutSeconds) &&
        e.invokeTimeoutSeconds >= 1 &&
        e.invokeTimeoutSeconds <= MAX_INVOKE_TIMEOUT_SECONDS
      )
    ) {
      errors.push(
        `destination ${e.id}: invokeTimeoutSeconds must be a number from 1 to ${MAX_INVOKE_TIMEOUT_SECONDS}`,
      );
    }
    checkSchema(errors, `destination ${e.id} settingsSchema`, e.settingsSchema);
    checkSchema(errors, `destination ${e.id} targetSchema`, e.targetSchema);
    checkSchema(errors, `destination ${e.id} inputSchema`, e.inputSchema);
    if (!['sync', 'poll', 'callback', 'none'].includes(e.tracking))
      errors.push(`destination ${e.id}: invalid tracking`);
    if (typeof e.idempotentInvoke !== 'boolean')
      errors.push(`destination ${e.id}: idempotentInvoke must be declared`);
    const dims = new Set<string>();
    for (const d of e.usage) {
      if (d.unit === '') errors.push(`destination ${e.id} usage ${d.id}: unit is required`);
      if (dims.has(d.id)) errors.push(`destination ${e.id} usage ${d.id}: duplicate dimension`);
      dims.add(d.id);
    }
    const primaries = (e.meters ?? []).filter((m) => m.primary === true).length;
    if (primaries > 1) errors.push(`destination ${e.id}: at most one primary meter`);
    for (const ex of e.examples ?? []) {
      const t = validateAgainst(e.targetSchema, ex.target);
      if (!t.valid)
        errors.push(`destination ${e.id}: example target invalid: ${t.errors.join('; ')}`);
      const i = validateAgainst(e.inputSchema, ex.input);
      if (!i.valid)
        errors.push(`destination ${e.id}: example input invalid: ${i.errors.join('; ')}`);
    }
    for (const a of e.actions ?? [])
      checkSchema(errors, `destination ${e.id} action ${a.id} argsSchema`, a.argsSchema);
  }

  for (const n of plugin.notifiers) {
    unique('notifier', n.id);
    checkIcon(`notifier ${n.id}`, n.icon);
    checkSchema(errors, `notifier ${n.id} settingsSchema`, n.settingsSchema);
  }
  for (const p of plugin.secretProviders) {
    unique('secret_provider', p.id);
    checkIcon(`secret provider ${p.id}`, p.icon);
    checkSchema(errors, `secret provider ${p.id} settingsSchema`, p.settingsSchema);
  }
  return errors;
}
