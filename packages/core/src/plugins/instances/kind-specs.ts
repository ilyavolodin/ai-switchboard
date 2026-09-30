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
import type { GaugeName } from '../../telemetry/telemetry.js';
import { typeInvokeTimeout, type LiveBase } from '../runtime.js';
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

/** The kinds whose rows have `secrets_resolved_at`. */
export const RESOLUTION_KINDS = ['source', 'destination'] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

export function recordsResolution(kind: InstanceKind): kind is ResolutionKind {
  return (RESOLUTION_KINDS as readonly InstanceKind[]).includes(kind);
}

/** Everything that differs between instance kinds; the builder, manager and health checks read it. */
export interface KindSpec<K extends InstanceKind> {
  /** Settings hold `secret://` references resolved before `create` (not for providers themselves). */
  resolvesSecrets: boolean;
  /** A disabled instance still gets a live object, flagged `disabled` (a push source keeps parsing). */
  buildsWhenDisabled: boolean;
  /** Reported per instance after each health probe. */
  healthGauge: GaugeName | undefined;
  /** A probe that cannot tell (`unknown`) keeps an `unhealthy` the pipeline stored (401/403). */
  keepsStoredUnhealthy: boolean;
  actions(type: TypeByKind[K]): readonly ActionSpec[] | undefined;
  live(input: LiveInput<K>): LiveByKind[K];
  /** The plugin object inside a live instance. */
  objectOf(live: LiveByKind[K]): ObjectByKind[K];
}

/** Providers first: every other kind resolves its settings through them. */
export const BUILD_ORDER = ['secret_provider', 'source', 'destination', 'notifier'] as const;

type Create<K extends InstanceKind> = (settings: Settings, ctx: PluginContext) => ObjectByKind[K];

/** Every type's `create(settings, ctx)`, the same for all kinds. */
export function createObject<K extends InstanceKind>(
  type: TypeByKind[K],
  settings: Settings,
  ctx: PluginContext,
): ObjectByKind[K] {
  return (type.create as Create<K>).call(type, settings, ctx);
}

function liveBase<T>(input: {
  row: LiveInput<InstanceKind>['row'];
  type: T;
  pluginName: string;
}): LiveBase<T> {
  const { row, type, pluginName } = input;
  return { id: row.id, name: row.name, typeId: row.typeId, pluginName, type };
}

export const KIND_SPECS: { [K in InstanceKind]: KindSpec<K> } = {
  source: {
    resolvesSecrets: true,
    buildsWhenDisabled: true,
    healthGauge: 'switchboard.source.health',
    keepsStoredUnhealthy: false,
    actions: (type) => type.actions,
    live: (input) => ({
      ...liveBase(input),
      source: input.object,
      eventTypes:
        input.type.dynamicEventTypes && input.type.instanceEventTypes
          ? input.type.instanceEventTypes(input.settings)
          : input.type.eventTypes,
      secretValues: input.secrets,
    }),
    objectOf: (live) => live.source,
  },
  destination: {
    resolvesSecrets: true,
    buildsWhenDisabled: true,
    healthGauge: 'switchboard.destination.health',
    keepsStoredUnhealthy: true,
    actions: (type) => type.actions,
    live: (input) => {
      const { type, settings } = input;
      return {
        ...liveBase(input),
        destination: input.object,
        usage: type.usageFor ? type.usageFor(settings) : type.usage,
        meters: type.metersFor ? type.metersFor(settings) : (type.meters ?? []),
        trackingFor: (target) => (type.trackingFor ? type.trackingFor(target) : type.tracking),
        idempotentFor: (target) =>
          type.idempotentFor ? type.idempotentFor(target) : type.idempotentInvoke,
        invokeTimeoutFor: (target) => typeInvokeTimeout(type, target),
        secretValues: input.secrets,
      };
    },
    objectOf: (live) => live.destination,
  },
  notifier: {
    resolvesSecrets: true,
    buildsWhenDisabled: true,
    healthGauge: undefined,
    keepsStoredUnhealthy: false,
    actions: () => undefined,
    live: (input) => ({ ...liveBase(input), notifier: input.object }),
    objectOf: (live) => live.notifier,
  },
  secret_provider: {
    resolvesSecrets: false,
    buildsWhenDisabled: false,
    healthGauge: undefined,
    keepsStoredUnhealthy: false,
    actions: () => undefined,
    live: (input) => ({ ...liveBase(input), provider: input.object }),
    objectOf: (live) => live.provider,
  },
};
