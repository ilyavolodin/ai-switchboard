import { definePlugin } from '@ai-switchboard/sdk';

import { envSecretProviderType } from './provider.js';

export { envSecretProviderType, SecretNotFoundError } from './provider.js';
export type { EnvSecretSettings } from './provider.js';

export default definePlugin({
  id: 'secrets-env',
  displayName: 'Environment variable secrets',
  description: 'Resolves secret://env/<NAME> references from environment variables.',
  secretProviders: [envSecretProviderType],
  capabilities: { network: [] },
});
