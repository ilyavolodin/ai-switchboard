import type { Clock } from '../../clock.js';
import { exists } from '../../util/fs.js';
import type { TypeRegistry } from '../type-registry.js';

import type { InstanceStore } from './store.js';

const DEFAULT_PROVIDER_TYPES = ['env', 'file'] as const;
const SECRETS_MOUNT = '/run/secrets';

/** First boot only: adds the env provider, and the file one where secrets are mounted. */
export async function ensureDefaultSecretProviders(deps: {
  store: InstanceStore;
  registry: Pick<TypeRegistry, 'has'>;
  clock: Clock;
  secretsMount?: string;
}): Promise<void> {
  const { store, registry, clock, secretsMount = SECRETS_MOUNT } = deps;
  if (await store.hasSecretProviders()) return;
  for (const typeId of DEFAULT_PROVIDER_TYPES) {
    if (!registry.has('secret_provider', typeId)) continue;
    if (typeId === 'file' && !(await exists(secretsMount))) continue;
    await store.addSecretProvider(typeId, clock.now());
  }
}
