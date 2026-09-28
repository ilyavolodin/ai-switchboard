import { definePlugin } from '@ai-switchboard/sdk';

import { httpDestinationType } from './destination.js';

export { httpDestinationType } from './destination.js';
export type { HttpSettings } from './settings.js';
export type { HttpTarget } from './target.js';
export type { HttpCallbackBody } from './callback.js';

export default definePlugin({
  id: 'destination-http',
  displayName: 'HTTP destination',
  description:
    'The universal destination: calls any HTTP endpoint, sync, by callback or fire-and-forget.',
  destinations: [httpDestinationType],
  // The universal destination calls whatever URL a process names, so it cannot list hosts.
  capabilities: { network: ['*'] },
});
