import {
  checkHealth,
  lowerCaseHeaders,
  responseSnippet,
  signSwitchboardBody,
  SWITCHBOARD_SIGNATURE_HEADER,
  withSettings,
  type Health,
  type NotificationMessage,
  type Notifier,
  type NotifierType,
  type PluginContext,
} from '@ai-switchboard/sdk';

import { settingsSchema, type WebhookNotifierSettings } from './settings.js';

export class WebhookNotifyError extends Error {
  override readonly name = 'WebhookNotifyError';
}

function createWebhookNotifier(settings: WebhookNotifierSettings, ctx: PluginContext): Notifier {
  return {
    async send(message: NotificationMessage): Promise<void> {
      // Sign exactly the bytes sent.
      const body = JSON.stringify(message);
      const headers: Record<string, string> = {
        ...lowerCaseHeaders(settings.headers),
        'content-type': 'application/json',
        'user-agent': 'ai-switchboard',
        ...(settings.secret !== undefined
          ? { [SWITCHBOARD_SIGNATURE_HEADER]: signSwitchboardBody(settings.secret, body) }
          : {}),
      };
      const res = await ctx.http.post(settings.url, { headers, body });
      if (!res.ok) {
        const snippet = responseSnippet(res);
        throw new WebhookNotifyError(
          `Webhook answered ${res.status}${snippet === '' ? '' : `: ${snippet}`}`,
        );
      }
    },

    health: (): Promise<Health> =>
      checkHealth(ctx, () =>
        Promise.resolve({
          status: 'unknown',
          message: 'A webhook cannot be checked without sending a notification.',
        }),
      ),
  };
}

export const webhookNotifierType: NotifierType = {
  // Ids are unique per kind, so this notifier shares `webhook` with the webhook source.
  id: 'webhook',
  displayName: 'Webhook',
  icon: 'webhook',
  description: 'POSTs each notification as JSON to any URL, optionally HMAC-signed.',
  settingsSchema,
  create: withSettings(settingsSchema, 'webhook notifier settings', createWebhookNotifier),
};
