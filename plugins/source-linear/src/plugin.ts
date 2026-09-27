import { definePlugin } from '@ai-switchboard/sdk';

import { linearSource } from './source.js';

export { linearSource } from './source.js';

export default definePlugin({
  id: 'source-linear',
  displayName: 'Linear source',
  description: 'Linear webhooks as Switchboard events, plus live issue state and actions.',
  sources: [linearSource],
  capabilities: { network: ['api.linear.app'], secrets: ['apiKey', 'webhookSecret'] },
});
