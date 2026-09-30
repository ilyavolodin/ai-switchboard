import type { InstanceKind } from '@ai-switchboard/core/domain';

export { instanceHref } from './hrefs.js';

/** "Linear — eng" reads as "Linear" where space is short. */
export function shortInstanceName(name: string): string {
  return name.split(' — ')[0] ?? name;
}

export const INSTANCE_KIND_LABEL: Record<InstanceKind, string> = {
  source: 'source',
  destination: 'destination',
  notifier: 'notifier',
  secret_provider: 'secret provider',
};
