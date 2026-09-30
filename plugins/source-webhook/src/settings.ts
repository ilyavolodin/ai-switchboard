import type { JSONSchema, Settings } from '@ai-switchboard/sdk';
import { isOneOf } from '@ai-switchboard/sdk/json';
import {
  customEventTypePattern,
  eventTypeDefinitionSchema,
  parseWith,
  type EventTypeDefinition,
} from '@ai-switchboard/sdk/schema';

import { PATH_PATTERN } from './paths.js';
import { ruleSchema, type MappedRule } from './settings-rules.js';
import {
  verificationConditions,
  verificationProperties,
  type VerificationMode,
} from './settings-verification.js';

export type { MappedAttribute, MappedRule } from './settings-rules.js';
export { VERIFICATION_MODES, type VerificationMode } from './settings-verification.js';

/** The source id, which is also the namespace of every event type an instance defines. */
export const SOURCE_ID = 'webhook';

export const MAPPING_MODES = ['quick', 'mapped', 'jsonata'] as const;
export type MappingMode = (typeof MAPPING_MODES)[number];

export const QUICK_DEFAULT_TYPE = 'webhook.request.received';

export interface WebhookSettings {
  verification: VerificationMode;
  secret?: string;
  signatureHeader: string;
  signaturePrefix: string;
  algorithm: 'sha256' | 'sha1';
  signatureEncoding: 'hex' | 'base64';
  sharedSecretHeader: string;
  deliveryIdHeader: string;
  /** Absent on instances created before the modes existed; see `mappingModeOf`. */
  mappingMode?: MappingMode;
  quickEventType: string;
  artifactIdPath?: string;
  artifactVersionPath?: string;
  rules?: MappedRule[];
  eventTypes?: EventTypeDefinition[];
  mapping?: string;
}

/**
 * The mode an instance runs in. Instances saved before the modes existed have no
 * `mappingMode`: they have a `mapping`, so they keep running as JSONata. A new instance with
 * neither is quick.
 */
export function mappingModeOf(settings: Settings): MappingMode {
  const mode = settings.mappingMode;
  if (isOneOf(MAPPING_MODES, mode)) return mode;
  return settings.mapping !== undefined ? 'jsonata' : 'quick';
}

const GROUP_EVENTS = 'Events';

const mappingProperties: Record<string, JSONSchema> = {
  mappingMode: {
    type: 'string',
    enum: [...MAPPING_MODES],
    // No `default` on purpose: the core stores defaults on save, and an instance saved before
    // the modes existed must keep its JSONata mapping (see `mappingModeOf`).
    'x-effectiveDefault': [
      { when: { required: ['mapping'] }, value: 'jsonata' },
      { value: 'quick' },
    ],
    title: 'How deliveries become events',
    description:
      'Quick needs no setup: every delivery is one event and the body’s top-level fields become its attributes. Mapped lets you name event types and pick each fact from the delivery by path. JSONata is a full expression for anything else.',
    'x-group': GROUP_EVENTS,
    'x-widget': 'radio',
    'x-enumLabels': {
      quick: 'Quick — one event per delivery, attributes from the body (no setup)',
      mapped: 'Mapped — name event types and pick fields by path',
      jsonata: 'JSONata — write a mapping expression (advanced)',
    },
  },
  quickEventType: {
    type: 'string',
    pattern: customEventTypePattern(SOURCE_ID),
    default: QUICK_DEFAULT_TYPE,
    title: 'Event type',
    description:
      'The one event type every delivery becomes. Processes pick it in their trigger. Must look like `webhook.<object>.<verb>`, e.g. `webhook.deploy.finished`; the artifact kind is `webhook.<object>`.',
    'x-group': GROUP_EVENTS,
  },
  artifactIdPath: {
    type: 'string',
    pattern: PATH_PATTERN,
    title: 'Artifact id path',
    description:
      'Where the id of the thing this delivery is about lives, e.g. `body.deployment.id`. Empty: `body.id` when the body has one, else a hash of the body (so every distinct delivery is its own artifact).',
    'x-widget': 'path',
    'x-placeholder': 'body.id',
    'x-group': GROUP_EVENTS,
  },
  artifactVersionPath: {
    type: 'string',
    pattern: PATH_PATTERN,
    title: 'Version path',
    description:
      'Optional. An updated-at time or revision in the delivery, e.g. `body.updated_at`. A redelivery with the same version is dropped as a duplicate; without one, the delivery id header (or a hash of the body) decides.',
    'x-widget': 'path',
    'x-group': GROUP_EVENTS,
  },
  rules: {
    type: 'array',
    minItems: 1,
    title: 'Event types',
    description:
      'Each rule names an event type and says where its facts are. A delivery is checked against the rules in order and the first rule whose condition holds produces the event; a rule without a condition takes everything, so put it last.',
    'x-help':
      'Paths are dotted and start at body, headers or query: `body.issue.id`, `headers.x-github-event`, `query.env`, `body.labels.0`. A name on a list reads it from every element: `body.labels.name` gives ["bug", "p1"]. Attributes are the named facts filters use (`attributes.priority = "high"`); each one is read from its path and converted to its type.',
    'x-group': GROUP_EVENTS,
    items: ruleSchema(SOURCE_ID),
  },
  eventTypes: {
    type: 'array',
    minItems: 1,
    items: eventTypeDefinitionSchema(SOURCE_ID, 'webhook.deploy.finished'),
    title: 'Event types',
    description:
      'The event types the mapping may produce, each with its attributes (the named facts filters use). A mapping result whose type is not listed here is dropped, and so is any attribute not declared for its type.',
    'x-group': GROUP_EVENTS,
  },
  mapping: {
    type: 'string',
    minLength: 1,
    title: 'Mapping',
    description:
      'A JSONata expression over `{ body, headers, query }` (body is the parsed JSON; header names are lower case). It returns one object, or a list of them for several events: `{ type, artifact: { kind, id, url?, version? }, attributes, occurredAt?, deliveryId? }`. Return nothing to ignore a delivery.',
    'x-help':
      'Example: body.status in ["success", "failure"] ? { "type": "webhook.deploy.finished", "artifact": { "kind": "deploy", "id": body.deployment.id, "version": body.deployment.updated_at }, "attributes": { "service": body.service, "status": body.status } }. Credential headers (authorization, cookie, the signature and secret headers) are removed first. $now() is the delivery’s receipt time and every evaluation has a 2 s limit.',
    'x-docs': { url: 'https://docs.jsonata.org/overview', label: 'JSONata documentation' },
    'x-widget': 'expression',
    'x-group': GROUP_EVENTS,
  },
  deliveryIdHeader: {
    type: 'string',
    default: 'x-delivery-id',
    title: 'Delivery id header',
    description:
      'Header with the sender’s own delivery id (GitHub: `x-github-delivery`). A redelivery with the same id is dropped as a duplicate when the artifact has no version.',
    'x-group': GROUP_EVENTS,
  },
};

/**
 * The mode conditions spell out `mappingModeOf`: an unset mode means JSONata when a mapping
 * exists (instances from before the modes) and quick otherwise.
 */
const mappingConditions: JSONSchema[] = [
  {
    if: {
      anyOf: [
        { required: ['mappingMode'], properties: { mappingMode: { const: 'quick' } } },
        { not: { anyOf: [{ required: ['mappingMode'] }, { required: ['mapping'] }] } },
      ],
    },
    then: {
      properties: { quickEventType: true, artifactIdPath: true, artifactVersionPath: true },
    },
  },
  {
    if: { required: ['mappingMode'], properties: { mappingMode: { const: 'mapped' } } },
    then: { required: ['rules'], properties: { rules: true } },
  },
  {
    if: {
      anyOf: [
        { required: ['mappingMode'], properties: { mappingMode: { const: 'jsonata' } } },
        { not: { required: ['mappingMode'] }, required: ['mapping'] },
      ],
    },
    then: {
      required: ['eventTypes', 'mapping'],
      properties: { eventTypes: true, mapping: true },
    },
  },
];

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { ...verificationProperties, ...mappingProperties },
  allOf: [...verificationConditions, ...mappingConditions],
};

export class WebhookSettingsError extends Error {
  override readonly name = 'WebhookSettingsError';
}

/** Validates a copy, so defaults do not leak back. */
export function readSettings(settings: Settings): WebhookSettings {
  return parseWith<WebhookSettings>(settingsSchema, settings, 'webhook settings', {
    error: WebhookSettingsError,
  });
}
