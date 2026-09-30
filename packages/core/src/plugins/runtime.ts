import type {
  EventTypeSpec,
  Destination,
  DestinationType,
  MeterSpec,
  Notifier,
  NotifierType,
  SecretProvider,
  SecretProviderType,
  Source,
  SourceType,
  TrackingMode,
  UsageDimension,
} from '@ai-switchboard/sdk';

import type { InstanceError } from '../domain/instance-error.js';
import type { InstanceKind, PluginErrorKind } from '../domain/status.js';

import type { TypeEntry } from './type-registry.js';

/** What every live instance carries: its row's identity and the plugin type it was built from. */
export interface LiveBase<T> {
  id: string;
  name: string;
  typeId: string;
  pluginName: string;
  type: T;
}

export interface LiveSource extends LiveBase<SourceType> {
  source: Source;
  /** The type's list, or the webhook's per-instance definitions. */
  eventTypes: EventTypeSpec[];
  /** Resolved secret values, so the core can check nothing leaks into attributes. */
  secretValues: string[];
}

export interface LiveDestination extends LiveBase<DestinationType> {
  destination: Destination;
  usage: UsageDimension[];
  meters: MeterSpec[];
  trackingFor(target: unknown): TrackingMode;
  idempotentFor(target: unknown): boolean;
  /** Seconds; undefined means the core applies the instance cap or its default. */
  invokeTimeoutFor(target: unknown): number | undefined;
  /** Resolved secret values of the instance's settings, redacted from what the backend returns. */
  secretValues: string[];
}

export interface LiveNotifier extends LiveBase<NotifierType> {
  notifier: Notifier;
}

export interface LiveSecretProvider extends LiveBase<SecretProviderType> {
  provider: SecretProvider;
}

/** The pipeline and the API read instances through this and never touch plugin modules directly. */
export interface PluginRuntime {
  sourceType(typeId: string): TypeEntry<SourceType> | undefined;
  destinationType(typeId: string): TypeEntry<DestinationType> | undefined;
  notifierType(typeId: string): TypeEntry<NotifierType> | undefined;
  secretProviderType(typeId: string): TypeEntry<SecretProviderType> | undefined;

  /**
   * Undefined when the instance is missing, failed to build or its plugin is unavailable. Disabled
   * instances still have a live object (a disabled push source must keep parsing so its events are
   * stored with `stage=source_disabled`); gate on the row's `enabled` column.
   */
  source(id: string): LiveSource | undefined;
  destination(id: string): LiveDestination | undefined;
  notifier(id: string): LiveNotifier | undefined;

  /** Why an instance has no live object, or (`disabled`) takes no work. */
  instanceError(id: string): InstanceError | undefined;

  reload(kind: InstanceKind, id: string): Promise<void>;

  recordPluginError(pluginName: string, kind: PluginErrorKind, detail?: string): void;
}

function positiveSeconds(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A throwing or non-positive per-target value falls back to the type's default. */
export function typeInvokeTimeout(type: DestinationType, target: unknown): number | undefined {
  let perTarget: unknown;
  try {
    perTarget = type.invokeTimeoutFor?.(target);
  } catch {
    perTarget = undefined;
  }
  return positiveSeconds(perTarget) ?? positiveSeconds(type.invokeTimeoutSeconds);
}
