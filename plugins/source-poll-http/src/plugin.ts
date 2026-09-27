import { definePlugin } from '@ai-switchboard/sdk';

import { pollHttpSource } from './source.js';

export { pollHttpSource } from './source.js';

export default definePlugin({
  id: 'source-poll-http',
  displayName: 'HTTP poll source',
  description:
    'The pull twin of the webhook source: poll a JSON endpoint and map items with JSONata.',
  sources: [pollHttpSource],
  // The endpoint is whatever the instance's URL says, so no narrower host list is possible.
  capabilities: { network: ['*'], secrets: ['token'] },
});
