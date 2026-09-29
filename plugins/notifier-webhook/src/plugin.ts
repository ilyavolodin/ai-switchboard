import { definePlugin } from '@ai-switchboard/sdk';

import { webhookNotifierType } from './notifier.js';

export { webhookNotifierType } from './notifier.js';
export type { WebhookNotifierSettings } from './settings.js';

export default definePlugin({
  id: 'notifier-webhook',
  displayName: 'Webhook notifier',
  description: 'POSTs notifications as JSON to any URL.',
  notifiers: [webhookNotifierType],
  // The receiving URL is whatever the admin configures.
  capabilities: { network: ['*'] },
});
