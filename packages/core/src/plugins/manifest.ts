import type { DestinationType, SourceType } from '@ai-switchboard/sdk';

import type { InstanceKind } from '../domain/status.js';

import type { AnyType } from './type-registry.js';

/** What `plugin_types.manifest` stores and the UI renders forms and pickers from. */
export function serializeType(kind: InstanceKind, type: AnyType): Record<string, unknown> {
  const base = {
    displayName: type.displayName,
    description: type.description,
    ...(type.icon !== undefined ? { icon: type.icon } : {}),
    settingsSchema: type.settingsSchema,
  };
  if (kind === 'source') {
    const t = type as SourceType;
    return {
      ...base,
      mode: t.mode,
      eventTypes: t.eventTypes,
      actions: t.actions ?? [],
      dynamicEventTypes: t.dynamicEventTypes ?? false,
      allowsUnauthenticated: t.allowsUnauthenticated ?? false,
    };
  }
  if (kind === 'destination') {
    const t = type as DestinationType;
    return {
      ...base,
      targetSchema: t.targetSchema,
      inputSchema: t.inputSchema,
      tracking: t.tracking,
      idempotentInvoke: t.idempotentInvoke,
      usage: t.usage,
      meters: t.meters ?? [],
      actions: t.actions ?? [],
      examples: t.examples ?? [],
    };
  }
  return base;
}
