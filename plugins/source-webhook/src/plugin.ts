import { definePlugin } from '@ai-switchboard/sdk';

import { webhookSource } from './source.js';

export { webhookSource } from './source.js';

export default definePlugin({
  id: 'source-webhook',
  displayName: 'Webhook source',
  description:
    'The universal source: any webhook becomes Switchboard events, with no setup, by path, or with JSONata.',
  sources: [webhookSource],
  // Push only: the webhook source makes no outbound calls.
  capabilities: { network: [] },
});
