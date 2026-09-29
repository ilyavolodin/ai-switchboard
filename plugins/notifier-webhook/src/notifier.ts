import {
  signHmac,
  type Health,
  type JSONSchema,
  type NotificationMessage,
  type Notifier,
  type NotifierType,
  type PluginContext,
  type Settings,
  parseWith,
} from '@ai-switchboard/sdk';

export interface WebhookNotifierSettings {
  url: string;
  /** When set, the body is signed: `x-switchboard-signature: sha256=<hex>`. */
  secret?: string;
  headers: Record<string, string>;
}

export const SIGNATURE_HEADER = 'x-switchboard-signature';

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

export class WebhookNotifyError extends Error {
  override readonly name = 'WebhookNotifyError';
}

function createWebhookNotifier(settings: WebhookNotifierSettings, ctx: PluginContext): Notifier {
  return {
    async send(message: NotificationMessage): Promise<void> {
      // Sign exactly the bytes sent.
      const body = JSON.stringify(message);
      const headers: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(settings.headers).map(([k, v]) => [k.toLowerCase(), v]),
        ),
        'content-type': 'application/json',
        'user-agent': 'ai-switchboard',
        ...(settings.secret !== undefined
          ? { [SIGNATURE_HEADER]: `sha256=${signHmac({ secret: settings.secret, payload: body })}` }
          : {}),
      };
      const res = await ctx.http.post(settings.url, { headers, body });
      if (!res.ok) {
        throw new WebhookNotifyError(
          `Webhook answered ${res.status}${res.text() === '' ? '' : `: ${res.text().slice(0, 200)}`}`,
        );
      }
    },

    health: (): Promise<Health> =>
      Promise.resolve({
        status: 'unknown',
        message: 'A webhook cannot be checked without sending a notification.',
        checkedAt: ctx.now().toISOString(),
      }),
  };
}

export const webhookNotifierType: NotifierType = {
  // Ids are unique per kind, so this notifier shares `webhook` with the webhook source.
  id: 'webhook',
  displayName: 'Webhook',
  icon: 'webhook',
  description: 'POSTs each notification as JSON to any URL, optionally HMAC-signed.',
  settingsSchema,
  create: (settings: Settings, ctx: PluginContext) =>
    createWebhookNotifier(
      parseWith<WebhookNotifierSettings>(settingsSchema, settings, 'webhook notifier settings'),
      ctx,
    ),
};
