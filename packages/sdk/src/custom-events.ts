/** Event types a person defines in a source's settings (the generic webhook and poll-http sources). */
import type { JSONSchema } from './types/common.js';
import type { ArtifactRef, Attributes, EventTypeSpec } from './types/events.js';

export const ATTRIBUTE_KINDS = ['string', 'number', 'boolean', 'string[]'] as const;
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];

/** Attribute names are identifiers, so filters can write `attributes.<name>`. */
export const ATTRIBUTE_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';

export interface AttributeDefinition {
  name: string;
  type: AttributeKind;
  description?: string;
}

export interface EventTypeDefinition {
  type: string;
  title: string;
  description?: string;
  attributes: AttributeDefinition[];
  example?: Record<string, unknown>;
}

/** Regex source for `<sourceId>.<object>.<verb>`. */
export function customEventTypePattern(sourceId: string): string {
  const escaped = sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}\\.[a-z][a-z0-9_-]*\\.[a-z][a-z0-9_-]*$`;
}

/** Settings-form schema for one `EventTypeDefinition`; `exampleType` appears in the field help. */
export function eventTypeDefinitionSchema(sourceId: string, exampleType: string): JSONSchema {
  return {
    type: 'object',
    required: ['type', 'title', 'attributes'],
    properties: {
      type: {
        type: 'string',
        pattern: customEventTypePattern(sourceId),
        title: 'Event type',
        description: `Must look like \`${sourceId}.<object>.<verb>\`, e.g. \`${exampleType}\`.`,
      },
      title: { type: 'string', minLength: 1, title: 'Title', description: 'Shown in the UI.' },
      description: {
        type: 'string',
        title: 'Description',
        description: 'What this event means, for the people writing filters.',
      },
      attributes: {
        type: 'array',
        title: 'Attributes',
        description: 'The flat facts the mapping produces for this event type.',
        items: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: {
              type: 'string',
              pattern: ATTRIBUTE_NAME_PATTERN,
              title: 'Name',
              description: 'Attribute key, e.g. `environment`.',
            },
            type: {
              type: 'string',
              enum: [...ATTRIBUTE_KINDS],
              title: 'Type',
              description: 'Value type of the attribute.',
            },
            description: {
              type: 'string',
              title: 'Description',
              description: 'What the attribute holds.',
            },
          },
        },
      },
      example: {
        type: 'object',
        title: 'Example attributes',
        description: 'An example attribute object shown in the filter editor.',
      },
    },
  };
}

const PLACEHOLDER: Record<AttributeKind, string | number | boolean | string[]> = {
  string: 'example',
  number: 0,
  boolean: false,
  'string[]': ['example'],
};

function attributeSchema(kind: AttributeKind, description?: string): JSONSchema {
  const base: JSONSchema =
    kind === 'string[]' ? { type: 'array', items: { type: 'string' } } : { type: kind };
  return description !== undefined ? { ...base, description } : base;
}

export interface CompiledEventType {
  spec: EventTypeSpec;
  attributes: Map<string, AttributeKind>;
}

function exampleFor(def: EventTypeDefinition, kinds: Map<string, AttributeKind>): Attributes {
  const example: Attributes = {};
  for (const [name, kind] of kinds) {
    const given = def.example?.[name];
    const coerced = given === undefined ? undefined : coerceAttribute(given, kind);
    example[name] = coerced ?? PLACEHOLDER[kind];
  }
  return example;
}

/**
 * Definitions outside `sourceId`'s namespace are skipped; for duplicate type ids and duplicate
 * attribute names the first one wins.
 */
export function compileEventTypes(
  sourceId: string,
  defs: EventTypeDefinition[],
): Map<string, CompiledEventType> {
  const out = new Map<string, CompiledEventType>();
  const pattern = new RegExp(customEventTypePattern(sourceId));
  for (const def of defs) {
    if (!pattern.test(def.type) || out.has(def.type)) continue;
    const kinds = new Map<string, AttributeKind>();
    const properties: Record<string, JSONSchema> = {};
    for (const attr of def.attributes) {
      if (kinds.has(attr.name)) continue;
      kinds.set(attr.name, attr.type);
      properties[attr.name] = attributeSchema(attr.type, attr.description);
    }
    out.set(def.type, {
      attributes: kinds,
      spec: {
        type: def.type,
        title: def.title,
        description: def.description ?? def.title,
        attributes: { type: 'object', properties, additionalProperties: false },
        examples: [exampleFor(def, kinds)],
      },
    });
  }
  return out;
}

/**
 * Forgiving coercion (numeric strings become numbers, a lone string becomes a string[]).
 * `undefined` means the value cannot be represented and the key should be dropped.
 */
export function coerceAttribute(
  value: unknown,
  kind: AttributeKind,
): string | number | boolean | string[] | undefined {
  switch (kind) {
    case 'string':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return undefined;
    case 'number': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return undefined;
    case 'string[]':
      if (typeof value === 'string') return [value];
      if (Array.isArray(value)) {
        return value.flatMap((v: unknown) =>
          typeof v === 'string'
            ? [v]
            : typeof v === 'number' || typeof v === 'boolean'
              ? [String(v)]
              : [],
        );
      }
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Epoch numbers below 1e11 are seconds, above are milliseconds. Unparseable gives `undefined`. */
export function toIsoTime(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.abs(value) < 1e11 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return toIsoTime(Number(value));
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}

export interface MappedEvent {
  type: string;
  artifact: ArtifactRef;
  attributes: Attributes;
  occurredAt: string | undefined;
  deliveryId: string | undefined;
}

/** `null` when the type is not declared or the artifact is unusable. Undeclared attributes are dropped. */
export function narrowMapped(
  item: unknown,
  types: Map<string, CompiledEventType>,
): MappedEvent | null {
  if (!isRecord(item) || typeof item.type !== 'string') return null;
  const compiled = types.get(item.type);
  if (!compiled || !isRecord(item.artifact)) return null;
  const kind = scalarString(item.artifact.kind);
  const id = scalarString(item.artifact.id);
  if (kind === undefined || id === undefined) return null;
  const artifact: ArtifactRef = { kind, id };
  const url = scalarString(item.artifact.url);
  if (url !== undefined) artifact.url = url;
  const version = scalarString(item.artifact.version);
  if (version !== undefined) artifact.version = version;

  const attributes: Attributes = {};
  const given = isRecord(item.attributes) ? item.attributes : {};
  for (const [name, attrKind] of compiled.attributes) {
    const value = coerceAttribute(given[name], attrKind);
    if (value !== undefined) attributes[name] = value;
  }
  return {
    type: item.type,
    artifact,
    attributes,
    occurredAt: toIsoTime(item.occurredAt),
    deliveryId: scalarString(item.deliveryId),
  };
}

const FLAT_VALUE_SCHEMA: JSONSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'array', items: { type: 'string' } },
  ],
};

/**
 * For event types whose attribute names are only known per delivery. Undeclared keys are
 * accepted only when flat, so the core's validation still refuses nested objects.
 */
export function openAttributesSchema(properties: Record<string, JSONSchema> = {}): JSONSchema {
  return { type: 'object', properties, additionalProperties: FLAT_VALUE_SCHEMA };
}

export interface FlattenOptions {
  /** Nested objects are flattened this many levels (default 1: `deployment.id` → `deployment_id`). */
  depth?: number;
  /** At most this many attributes (default 64); later keys are dropped. */
  maxAttributes?: number;
  /** Strings longer than this are dropped rather than cut (default 1024). */
  maxStringLength?: number;
}

/** A key made filter-friendly: `x-event-type` → `x_event_type`, `1st` → `_1st`. */
export function attributeKey(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/**
 * Arrays of scalars become string arrays; nulls, arrays of objects, deeper objects and
 * over-long strings are dropped, so `attributes.<name>` always works in a filter.
 */
export function flattenAttributes(value: unknown, options: FlattenOptions = {}): Attributes {
  const depth = options.depth ?? 1;
  const max = options.maxAttributes ?? 64;
  const maxLength = options.maxStringLength ?? 1024;
  const out: Attributes = {};
  const put = (key: string, v: string | number | boolean | string[]): void => {
    if (Object.keys(out).length >= max || key in out) return;
    out[key] = v;
  };
  const walk = (obj: Record<string, unknown>, prefix: string, level: number): void => {
    for (const [rawKey, v] of Object.entries(obj)) {
      const key = prefix === '' ? attributeKey(rawKey) : `${prefix}_${attributeKey(rawKey)}`;
      if (typeof v === 'string') {
        if (v.length <= maxLength) put(key, v);
      } else if (typeof v === 'number') {
        if (Number.isFinite(v)) put(key, v);
      } else if (typeof v === 'boolean') {
        put(key, v);
      } else if (Array.isArray(v)) {
        const scalars = v.every(
          (x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean',
        );
        if (scalars) {
          const list = v.map((x: string | number | boolean) => String(x));
          if (list.every((x) => x.length <= maxLength)) put(key, list);
        }
      } else if (isRecord(v) && level < depth) {
        walk(v, key, level + 1);
      }
    }
  };
  if (isRecord(value)) walk(value, '', 0);
  return out;
}
