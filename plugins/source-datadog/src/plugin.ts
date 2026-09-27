import { definePlugin } from '@ai-switchboard/sdk';

import { API_HOSTS, datadogSource } from './source.js';

export { datadogSource } from './source.js';

export default definePlugin({
  id: 'source-datadog',
  displayName: 'Datadog source',
  description: 'Datadog monitor alerts as Switchboard events, with live monitor state.',
  sources: [datadogSource],
  capabilities: { network: API_HOSTS, secrets: ['sharedSecret', 'apiKey', 'appKey'] },
});
