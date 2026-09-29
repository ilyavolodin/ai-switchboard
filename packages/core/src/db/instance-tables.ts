import type { InstanceKind } from '../domain/status.js';

import { destinations, notifiers, secretProviders, sources } from './schema.js';

export const INSTANCE_TABLES = {
  source: sources,
  destination: destinations,
  notifier: notifiers,
  secret_provider: secretProviders,
} as const satisfies Record<InstanceKind, unknown>;

export type InstanceTable = (typeof INSTANCE_TABLES)[InstanceKind];

export type InstanceRow<K extends InstanceKind> = (typeof INSTANCE_TABLES)[K]['$inferSelect'];
