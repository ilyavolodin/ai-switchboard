import { definePlugin } from '@ai-switchboard/sdk';

import { githubSource } from './source.js';

export { githubSource } from './source.js';

export default definePlugin({
  id: 'source-github',
  displayName: 'GitHub source',
  description: 'GitHub webhooks as Switchboard events, plus live state, links and actions.',
  sources: [githubSource],
  capabilities: {
    network: ['api.github.com'],
    secrets: ['privateKey', 'token', 'webhookSecret'],
  },
});
