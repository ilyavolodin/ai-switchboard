import type { InstanceKind } from '@ai-switchboard/core/domain';

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

export function instanceHref(kind: InstanceKind, id: string): string {
  switch (kind) {
    case 'source':
      return `/sources/${encodeURIComponent(id)}`;
    case 'destination':
      return `/destinations/${encodeURIComponent(id)}`;
    case 'notifier':
      return '/settings/notifiers';
    case 'secret_provider':
      return '/settings/secret-providers';
  }
}
