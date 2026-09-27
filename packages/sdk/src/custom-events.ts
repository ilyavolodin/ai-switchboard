/**
 * Event types a person defines in a source's settings (the generic webhook and poll-http sources
 * do this): the settings-form schema for a definition, compiling definitions into `EventTypeSpec`s,
 * and narrowing a mapping's output to a declared event.
 */
import type { JSONSchema } from './types/common.js';
import type { ArtifactRef, Attributes, EventTypeSpec } from './types/events.js';

/** The attribute value kinds a person can declare for a custom event type. */
export const ATTRIBUTE_KINDS = ['string', 'number', 'boolean', 'string[]'] as const;
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];

/** Attribute names are identifiers, so filters can write `attributes.<name>`. */
export const ATTRIBUTE_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';

/** One attribute of a person-defined event type. */
export interface AttributeDefinition {
  name: string;
  type: AttributeKind;
  description?: string;
}

/** One person-defined event type, as stored in the instance settings. */
export interface EventTypeDefinition {
  type: string;
  title: string;
  description?: string;
  attributes: AttributeDefinition[];
  example?: Record<string, unknown>;
}

/** The regex (as a string) a custom event type id must match: `<sourceId>.<object>.<verb>`. */
export function customEventTypePattern(sourceId: string): string {
  const escaped = sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}\\.[a-z][a-z0-9_-]*\\.[a-z][a-z0-9_-]*$`;
}

/**
 * JSON Schema for one `EventTypeDefinition` inside a source's settings form. `exampleType` is
 * shown in the field description, e.g. `webhook.deploy.finished`.
 */
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

/** A definition compiled for mapping: the spec plus a name → kind lookup. */
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
 * Build the instance's event types from its definitions. Definitions whose type is outside
 * `sourceId`'s namespace are skipped; duplicate type ids keep the first definition; duplicate
 * attribute names keep the first declaration.
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
 * Coerce a mapped value to the declared kind, forgivingly: numbers become strings for a string
 * attribute, numeric strings become numbers, a lone string becomes a one-element string[].
 * Returns `undefined` when the value cannot be represented, and the key is dropped.
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

/**
 * Normalise a timestamp from a mapping: ISO strings and epoch numbers (seconds below 1e11,
 * milliseconds above) become ISO-8601. Anything unparseable yields `undefined`.
 */
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

/** One mapping result, validated and narrowed. */
export interface MappedEvent {
  type: string;
  artifact: ArtifactRef;
  attributes: Attributes;
  occurredAt: string | undefined;
  deliveryId: string | undefined;
}

/**
 * Narrow one mapping result to a `MappedEvent`, or `null` when its type is not declared or its
 * artifact is unusable. Undeclared attribute keys are dropped.
 */
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
