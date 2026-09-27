import { definePlugin } from '@ai-switchboard/sdk';

import { httpExecutorType } from './executor.js';

export { httpExecutorType } from './executor.js';
export type { HttpSettings } from './settings.js';
export type { HttpTarget } from './target.js';
export type { HttpCallbackBody } from './callback.js';

export default definePlugin({
  id: 'executor-http',
  displayName: 'HTTP executor',
  description:
    'The universal executor: calls any HTTP endpoint, sync, by callback or fire-and-forget.',
  executors: [httpExecutorType],
  // The universal executor calls whatever URL a process names, so it cannot list hosts.
  capabilities: { network: ['*'] },
});
