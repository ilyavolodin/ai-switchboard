import { formatErrors, compileSchema, type JSONSchema, type Settings } from '@ai-switchboard/sdk';

import { eventTypeDefinitionSchema, type EventTypeDefinition } from './event-types.js';

export const VERIFICATION_MODES = ['hmac', 'shared_secret', 'none'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

/** Settings after validation, with defaults applied. */
export interface WebhookSettings {
  verification: VerificationMode;
  secret?: string;
  signatureHeader: string;
  signaturePrefix: string;
  algorithm: 'sha256' | 'sha1';
  signatureEncoding: 'hex' | 'base64';
  sharedSecretHeader: string;
  deliveryIdHeader: string;
  eventTypes: EventTypeDefinition[];
  mapping: string;
}

const GROUP_VERIFY = 'Verification';

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['eventTypes', 'mapping'],
  properties: {
    verification: {
      type: 'string',
      enum: [...VERIFICATION_MODES],
      default: 'hmac',
      title: 'Verification',
      description:
        'How deliveries are authenticated: an HMAC signature over the body, a shared-secret header, or none (evaluation only; the UI marks the instance unauthenticated).',
      'x-group': GROUP_VERIFY,
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
    deliveryIdHeader: {
      type: 'string',
      default: 'x-delivery-id',
      title: 'Delivery id header',
      description:
        'Header with the sender’s own delivery id. Used when the mapping gives no `deliveryId`; part of the dedupe key when the artifact has no version.',
      'x-group': 'Mapping',
    },
    eventTypes: {
      type: 'array',
      minItems: 1,
      items: eventTypeDefinitionSchema,
      title: 'Event types',
      description: 'The event types this instance produces, each with its flat attributes.',
      'x-group': 'Event types',
    },
    mapping: {
      type: 'string',
      minLength: 1,
      title: 'Mapping',
      description:
        'JSONata over `{ body, headers, query }` yielding one object or an array of `{ type, artifact: { kind, id, url?, version? }, attributes, occurredAt?, deliveryId? }`.',
      'x-widget': 'expression',
      'x-group': 'Mapping',
    },
  },
  allOf: [
    {
      if: { properties: { verification: { enum: ['hmac', 'shared_secret'] } } },
      then: { required: ['secret'], properties: { secret: { minLength: 1 } } },
    },
  ],
};

/** Thrown by `create` when the instance settings are unusable. */
export class WebhookSettingsError extends Error {
  override readonly name = 'WebhookSettingsError';
}

/** Validate settings against the schema (on a copy, so defaults do not leak back) and narrow. */
export function readSettings(settings: Settings): WebhookSettings {
  const copy = structuredClone(settings);
  const validate = compileSchema(settingsSchema);
  if (!validate(copy)) {
    throw new WebhookSettingsError(
      `Invalid webhook settings: ${formatErrors(validate.errors).join('; ')}`,
    );
  }
  return copy as unknown as WebhookSettings;
}
