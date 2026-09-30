/** The verification fields of the settings form, for `settings.ts`. Browser-safe like it. */
import type { JSONSchema } from '@ai-switchboard/sdk';

export const VERIFICATION_MODES = ['hmac', 'shared_secret', 'none'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

const GROUP_VERIFY = 'Verification';

export const verificationProperties: Record<string, JSONSchema> = {
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
    description: 'Text before the digest in the signature header, e.g. `sha256=`. Empty for none.',
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
};

/**
 * Each branch names the fields its mode uses: the UI shows them only while the branch applies
 * (so `verification: none` hides the secret and header fields and nothing is required).
 */
export const verificationConditions: JSONSchema[] = [
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
];
