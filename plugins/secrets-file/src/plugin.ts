import { definePlugin } from '@ai-switchboard/sdk';

import { fileSecretProviderType } from './provider.js';

export { fileSecretProviderType, SecretNotFoundError } from './provider.js';
export type { FileSecretSettings } from './provider.js';

export default definePlugin({
  id: 'secrets-file',
  displayName: 'Mounted file secrets',
  description: 'Resolves secret://file/<name> references from mounted files.',
  secretProviders: [fileSecretProviderType],
  capabilities: { network: [] },
});
