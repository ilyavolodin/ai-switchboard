import {
  ATTRIBUTE_KINDS,
  ATTRIBUTE_NAME_PATTERN,
  customEventTypePattern,
  eventTypeDefinitionSchema,
  parseWith,
  type AttributeKind,
  type EventTypeDefinition,
  type JSONSchema,
  type Settings,
} from '@ai-switchboard/sdk';

import { PATH_PATTERN } from './paths.js';

/** The source id, which is also the namespace of every event type an instance defines. */
export const SOURCE_ID = 'webhook';

export const VERIFICATION_MODES = ['hmac', 'shared_secret', 'none'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

export const MAPPING_MODES = ['quick', 'mapped', 'jsonata'] as const;
export type MappingMode = (typeof MAPPING_MODES)[number];

export const QUICK_DEFAULT_TYPE = 'webhook.request.received';

export interface MappedAttribute {
  name: string;
  path: string;
  type: AttributeKind;
  description?: string;
}

export interface MappedRule {
  type: string;
  title: string;
  description?: string;
  when?: { path?: string; equals?: string };
  artifactKind: string;
  artifactIdPath: string;
  artifactUrlPath?: string;
  artifactVersionPath?: string;
  occurredAtPath?: string;
  attributes?: MappedAttribute[];
}

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
  if (typeof mode === 'string' && (MAPPING_MODES as readonly string[]).includes(mode)) {
    return mode as MappingMode;
  }
  return settings.mapping !== undefined ? 'jsonata' : 'quick';
}

const GROUP_VERIFY = 'Verification';
const GROUP_EVENTS = 'Events';

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    verification: {
      type: 'string',
      enum: [...VERIFICATION_MODES],
      default: 'hmac',
      title: 'Verification',
      description:
        'How deliveries are authenticated: an HMAC signature over the body, a shared-secret header, or none (evaluation only; the instance is marked unauthenticated).',
      'x-group': GROUP_VERIFY,
      'x-widget': 'radio',
      'x-enumLabels': {
        hmac: 'HMAC signature over the body',
        shared_secret: 'Shared-secret header',
        none: 'None — accept unauthenticated deliveries (evaluation only)',
      },
      'x-warning': {
        when: { const: 'none' },
        message: 'Anyone who knows the URL can send events — evaluation only.',
      },
    },
    secret: {
      type: 'string',
      title: 'Secret',
      description:
        'The HMAC key or the shared secret the sender includes. Required unless verification is none.',
      'x-secret': true,
      'x-group': GROUP_VERIFY,
    },
    signatureHeader: {
      type: 'string',
      default: 'x-signature-256',
      title: 'Signature header',
      description: 'Header that carries the HMAC signature (hmac mode).',
      'x-group': GROUP_VERIFY,
    },
    signaturePrefix: {
      type: 'string',
      default: 'sha256=',
      title: 'Signature prefix',
      description:
        'Text before the digest in the signature header, e.g. `sha256=`. Empty for none.',
      'x-group': GROUP_VERIFY,
    },
    algorithm: {
      type: 'string',
      enum: ['sha256', 'sha1'],
      default: 'sha256',
      title: 'HMAC algorithm',
      description: 'Digest algorithm of the HMAC (hmac mode).',
      'x-group': GROUP_VERIFY,
    },
    signatureEncoding: {
      type: 'string',
      enum: ['hex', 'base64'],
      default: 'hex',
      title: 'Signature encoding',
      description: 'How the sender encodes the digest (hmac mode).',
      'x-group': GROUP_VERIFY,
    },
    sharedSecretHeader: {
      type: 'string',
      default: 'x-webhook-secret',
      title: 'Shared-secret header',
      description: 'Header that carries the shared secret (shared_secret mode).',
      'x-group': GROUP_VERIFY,
    },
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
      items: {
        type: 'object',
        title: 'Rule',
        required: ['type', 'title', 'artifactKind', 'artifactIdPath'],
        properties: {
          type: {
            type: 'string',
            pattern: customEventTypePattern(SOURCE_ID),
            title: 'Event type',
            description: 'Must look like `webhook.<object>.<verb>`, e.g. `webhook.issue.created`.',
          },
          title: { type: 'string', minLength: 1, title: 'Title', description: 'Shown in the UI.' },
          description: {
            type: 'string',
            title: 'Description',
            description: 'What this event means, for the people writing filters.',
          },
          when: {
            type: 'object',
            title: 'Only when',
            description:
              'Optional. The rule applies only when the value at this path equals the text (or, with no text, when the path has any value). Leave empty to take every delivery.',
            properties: {
              path: {
                type: 'string',
                pattern: PATH_PATTERN,
                title: 'Path',
                description: 'e.g. `headers.x-event-type` or `body.action`.',
                'x-widget': 'path',
              },
              equals: {
                type: 'string',
                title: 'Equals',
                description: 'e.g. `issue.created`. Compared as text.',
              },
            },
          },
          artifactKind: {
            type: 'string',
            minLength: 1,
            title: 'Artifact kind',
            description:
              'What the event is about, e.g. `issue` or `deploy`. Events about the same kind and id are the same artifact in traces.',
          },
          artifactIdPath: {
            type: 'string',
            pattern: PATH_PATTERN,
            title: 'Artifact id path',
            description: 'e.g. `body.issue.id`. A delivery without a value here produces no event.',
            'x-widget': 'path',
          },
          artifactUrlPath: {
            type: 'string',
            pattern: PATH_PATTERN,
            title: 'Artifact URL path',
            description: 'Optional. A link to the thing, e.g. `body.issue.url`.',
            'x-widget': 'path',
          },
          artifactVersionPath: {
            type: 'string',
            pattern: PATH_PATTERN,
            title: 'Version path',
            description:
              'Optional. An updated-at time or revision, e.g. `body.issue.updated_at`, so a redelivery is dropped as a duplicate.',
            'x-widget': 'path',
          },
          occurredAtPath: {
            type: 'string',
            pattern: PATH_PATTERN,
            title: 'Occurred-at path',
            description:
              'Optional. When it happened (ISO time or epoch seconds/ms). Empty: when the delivery arrived.',
            'x-widget': 'path',
          },
          attributes: {
            type: 'array',
            title: 'Attributes',
            description:
              'The named facts filters can use. Each is read from a path in the delivery, e.g. name `priority`, path `body.issue.priority`, type string.',
            items: {
              type: 'object',
              title: 'Attribute',
              required: ['name', 'path', 'type'],
              properties: {
                name: {
                  type: 'string',
                  pattern: ATTRIBUTE_NAME_PATTERN,
                  title: 'Name',
                  description: 'How filters refer to it: `attributes.<name>`. Letters, digits, _.',
                },
                path: {
                  type: 'string',
                  pattern: PATH_PATTERN,
                  title: 'Path',
                  description: 'Where the value is, e.g. `body.issue.priority`.',
                  'x-widget': 'path',
                },
                type: {
                  type: 'string',
                  enum: [...ATTRIBUTE_KINDS],
                  default: 'string',
                  title: 'Type',
                  description:
                    'Values are converted: numbers to text for string, "42" to 42 for number, a single text to a one-item list for string[].',
                },
                description: {
                  type: 'string',
                  title: 'Description',
                  description: 'What the attribute holds, shown in the filter editor.',
                },
              },
            },
          },
        },
      },
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
  },
  // Each branch names the fields its mode uses: the UI shows them only while the branch applies
  // (so `verification: none` hides the secret and header fields and nothing is required).
  allOf: [
    {
      if: { properties: { verification: { const: 'hmac' } } },
      then: {
        required: ['secret'],
        properties: {
          secret: { minLength: 1 },
          signatureHeader: true,
          signaturePrefix: true,
          algorithm: true,
          signatureEncoding: true,
        },
      },
    },
    {
      if: { properties: { verification: { const: 'shared_secret' } } },
      then: {
        required: ['secret'],
        properties: { secret: { minLength: 1 }, sharedSecretHeader: true },
      },
    },
    // The mode conditions spell out `mappingModeOf`: an unset mode means JSONata when a
    // mapping exists (instances from before the modes) and quick otherwise.
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
  ],
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
