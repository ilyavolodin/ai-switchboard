import type { InstanceSummary } from '@ai-switchboard/core/contract';
import { isSecretProviderSegment } from '@ai-switchboard/sdk/schema';

/**
 * The core resolves `secret://<provider>/…` through the instance named `<provider>`. `undefined`
 * while the list is still loading.
 */
export function secretProviderIds(instances: InstanceSummary[] | undefined): string[] | undefined {
  if (instances === undefined) return undefined;
  const ids = instances
    .filter((i) => i.enabled)
    .map((i) => (isSecretProviderSegment(i.name) ? i.name : i.typeId))
    .filter((id) => isSecretProviderSegment(id));
  return [...new Set(ids)];
}

/** By name, or by type for an instance whose name is not a plain id. */
export function instanceForProvider(
  provider: string,
  instances: InstanceSummary[] | undefined,
): InstanceSummary | undefined {
  return (
    instances?.find((i) => i.name === provider) ??
    instances?.find((i) => !isSecretProviderSegment(i.name) && i.typeId === provider)
  );
}
