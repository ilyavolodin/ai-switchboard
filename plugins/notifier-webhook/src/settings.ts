import type { JSONSchema } from '@ai-switchboard/sdk';

export interface WebhookNotifierSettings {
  url: string;
  /** When set, the body is signed: `x-switchboard-signature: sha256=<hex>`. */
  secret?: string;
  headers: Record<string, string>;
}

export const settingsSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'Webhook notifier',
  description: 'POSTs each notification as JSON to a URL.',
  required: ['url'],
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      pattern: '^https?://',
      title: 'URL',
      description: 'Receives a POST with the notification as JSON.',
      'x-group': 'Delivery',
    },
    secret: {
      type: 'string',
      minLength: 16,
      title: 'Signing secret',
      description:
        'Optional. Signs the raw body with HMAC-SHA256 in `x-switchboard-signature: sha256=<hex>`.',
      'x-secret': true,
      'x-group': 'Delivery',
    },
    headers: {
      type: 'object',
      title: 'Headers',
      description: 'Extra request headers (not secret; use the signing secret to authenticate).',
      propertyNames: { pattern: "^[A-Za-z0-9!#$%&'*+.^_`|~-]+$" },
      additionalProperties: { type: 'string' },
      default: {},
      'x-group': 'Delivery',
    },
  },
};
