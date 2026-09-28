import { definePlugin } from '@ai-switchboard/sdk';

import { logDestinationType } from './destination.js';

export { logDestinationType } from './destination.js';
export type { LogSettings, LogTarget, Outcome } from './destination.js';

export default definePlugin({
  id: 'destination-log',
  displayName: 'Log destination (testing)',
  description:
    'Logs every invocation and simulates outcomes, delays and a meter. For trying processes out.',
  destinations: [logDestinationType],
  capabilities: { network: [] },
});
