import type { SecretProviderDependentDTO } from '../../contract/index.js';
import { providerDependents as dependentsOf } from '../../services/secret-providers.js';
import type { ReadDeps } from './deps.js';

export function providerDependents(
  deps: ReadDeps,
  providerNames: readonly string[],
): Promise<Map<string, SecretProviderDependentDTO[]>> {
  return dependentsOf(deps, providerNames);
}
