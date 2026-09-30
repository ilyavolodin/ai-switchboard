import type { ProviderSecretsResponse, SecretProviderDependentDTO } from '../../contract/index.js';
import {
  providerDependents as dependentsOf,
  providerSecrets as secretsOf,
} from '../../services/secret-providers.js';
import type { ApiContext } from '../context.js';

export function providerDependents(
  ctx: ApiContext,
  providerNames: readonly string[],
): Promise<Map<string, SecretProviderDependentDTO[]>> {
  return dependentsOf(ctx, providerNames);
}

export function providerSecrets(ctx: ApiContext, id: string): Promise<ProviderSecretsResponse> {
  return secretsOf(ctx, id);
}
