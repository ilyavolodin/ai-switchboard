import { definePlugin } from '@ai-switchboard/sdk';

import { logExecutorType } from './executor.js';

export { logExecutorType } from './executor.js';
export type { LogSettings, LogTarget, Outcome } from './executor.js';

export default definePlugin({
  id: 'executor-log',
  displayName: 'Log executor (testing)',
  description:
    'Logs every invocation and simulates outcomes, delays and a meter. For trying processes out.',
  executors: [logExecutorType],
  capabilities: { network: [] },
});
