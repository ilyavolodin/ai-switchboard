import type {
  ActionSpec,
  Destination,
  Notifier,
  PluginContext,
  SecretProvider,
  Settings,
  Source,
} from '@ai-switchboard/sdk';

import type { InstanceKind } from '../../domain/status.js';
import { typeInvokeTimeout } from '../runtime.js';
import type { TypeByKind } from '../type-registry.js';

import type { LiveByKind } from './live-set.js';
import type { InstanceRowHead } from './store.js';

export interface ObjectByKind {
  source: Source;
  destination: Destination;
  notifier: Notifier;
  secret_provider: SecretProvider;
}

export interface LiveInput<K extends InstanceKind> {
  row: Pick<InstanceRowHead, 'id' | 'name' | 'typeId'>;
  type: TypeByKind[K];
  pluginName: string;
  object: ObjectByKind[K];
  settings: Settings;
  secrets: string[];
}

export interface KindSpec<K extends InstanceKind> {
  /** Settings hold `secret://` references resolved before `create` (not for providers themselves). */
  resolvesSecrets: boolean;
  /** A disabled instance still gets a live object, flagged `disabled` (a push source keeps parsing). */
  buildsWhenDisabled: boolean;
  /** Record `secrets_resolved_at` after a build. */
  recordsResolution: boolean;
  actions(type: TypeByKind[K]): readonly ActionSpec[] | undefined;
  create(type: TypeByKind[K], settings: Settings, ctx: PluginContext): ObjectByKind[K];
  live(input: LiveInput<K>): LiveByKind[K];
  /** The plugin object inside a live instance. */
  objectOf(live: LiveByKind[K]): ObjectByKind[K];
}

/** Providers first: every other kind resolves its settings through them. */
export const BUILD_ORDER = ['secret_provider', 'source', 'destination', 'notifier'] as const;

export const KIND_SPECS: { [K in InstanceKind]: KindSpec<K> } = {
  source: {
    resolvesSecrets: true,
    buildsWhenDisabled: true,
    recordsResolution: true,
    actions: (type) => type.actions,
    create: (type, settings, ctx) => type.create(settings, ctx),
    live: ({ row, type, pluginName, object, settings, secrets }) => ({
      id: row.id,
      name: row.name,
      typeId: row.typeId,
      pluginName,
      type,
      source: object,
      eventTypes:
        type.dynamicEventTypes && type.instanceEventTypes
          ? type.instanceEventTypes(settings)
          : type.eventTypes,
      secretValues: secrets,
    }),
    objectOf: (live) => live.source,
  },
  destination: {
    resolvesSecrets: true,
    buildsWhenDisabled: true,
    recordsResolution: true,
    actions: (type) => type.actions,
    create: (type, settings, ctx) => type.create(settings, ctx),
    live: ({ row, type, pluginName, object, settings, secrets }) => ({
      id: row.id,
      name: row.name,
      typeId: row.typeId,
      pluginName,
      type,
      destination: object,
      usage: type.usageFor ? type.usageFor(settings) : type.usage,
      meters: type.metersFor ? type.metersFor(settings) : (type.meters ?? []),
      trackingFor: (target) => (type.trackingFor ? type.trackingFor(target) : type.tracking),
      idempotentFor: (target) =>
        type.idempotentFor ? type.idempotentFor(target) : type.idempotentInvoke,
      invokeTimeoutFor: (target) => typeInvokeTimeout(type, target),
      secretValues: secrets,
    }),
    objectOf: (live) => live.destination,
  },
  notifier: {
    resolvesSecrets: true,
    buildsWhenDisabled: true,
    recordsResolution: false,
    actions: () => undefined,
    create: (type, settings, ctx) => type.create(settings, ctx),
    live: ({ row, type, object }) => ({
      id: row.id,
      name: row.name,
      typeId: row.typeId,
      type,
      notifier: object,
    }),
    objectOf: (live) => live.notifier,
  },
  secret_provider: {
    resolvesSecrets: false,
    buildsWhenDisabled: false,
    recordsResolution: false,
    actions: () => undefined,
    create: (type, settings, ctx) => type.create(settings, ctx),
    live: ({ row, type, object }) => ({
      id: row.id,
      name: row.name,
      typeId: row.typeId,
      type,
      provider: object,
    }),
    objectOf: (live) => live.provider,
  },
};
