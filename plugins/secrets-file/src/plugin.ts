import { definePlugin } from '@ai-switchboard/sdk';

import { fileSecretProviderType } from './provider.js';

export { SecretNotFoundError } from '@ai-switchboard/sdk';
export { fileSecretProviderType } from './provider.js';
export type { FileSecretSettings } from './settings.js';

export default definePlugin({
  id: 'secrets-file',
  displayName: 'Mounted file secrets',
  description: 'Resolves secret://file/<name> references from mounted files.',
  secretProviders: [fileSecretProviderType],
  capabilities: { network: [] },
});
