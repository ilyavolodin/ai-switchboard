import { definePlugin } from '@ai-switchboard/sdk';

import { envSecretProviderType } from './provider.js';

export { SecretNotFoundError } from '@ai-switchboard/sdk';
export { envSecretProviderType } from './provider.js';
export type { EnvSecretSettings } from './settings.js';

export default definePlugin({
  id: 'secrets-env',
  displayName: 'Environment variable secrets',
  description: 'Resolves secret://env/<NAME> references from environment variables.',
  secretProviders: [envSecretProviderType],
  capabilities: { network: [] },
});
