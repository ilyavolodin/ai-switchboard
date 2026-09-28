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

/** A live source instance built from a `sources` row. */
export interface LiveSource {
  id: string;
  name: string;
  typeId: string;
  pluginName: string;
  type: SourceType;
  source: Source;
  /** Event types this instance can emit (the type's list, or the webhook's per-instance definitions). */
  eventTypes: EventTypeSpec[];
  /** Resolved secret values, so the core can check nothing leaks into attributes. */
  secretValues: string[];
}

export interface LiveDestination {
  id: string;
  name: string;
  typeId: string;
  pluginName: string;
  type: DestinationType;
  destination: Destination;
  usage: UsageDimension[];
  meters: MeterSpec[];
  trackingFor(target: unknown): TrackingMode;
  idempotentFor(target: unknown): boolean;
  /**
   * The type's invoke timeout for `target`, in seconds: `invokeTimeoutFor(target)`, else
   * `invokeTimeoutSeconds`, else undefined (the core then applies the instance cap or its default).
   */
  invokeTimeoutFor(target: unknown): number | undefined;
  /** Resolved secret values of the instance's settings, redacted from what the backend returns. */
  secretValues?: string[];
}

export interface LiveNotifier {
  id: string;
  name: string;
  typeId: string;
  type: NotifierType;
  notifier: Notifier;
}

export interface LiveSecretProvider {
  id: string;
  name: string;
  typeId: string;
  type: SecretProviderType;
  provider: SecretProvider;
}

/**
 * The plugin host's view of what is running. The pipeline and the API read instances through
 * this and never touch plugin modules directly.
 */
export interface PluginRuntime {
  sourceType(typeId: string): { type: SourceType; pluginName: string } | undefined;
  destinationType(typeId: string): { type: DestinationType; pluginName: string } | undefined;
  notifierType(typeId: string): { type: NotifierType; pluginName: string } | undefined;
  secretProviderType(typeId: string): { type: SecretProviderType; pluginName: string } | undefined;

  /**
   * The live object for an instance, or undefined when the instance is missing, failed to build
   * (secret error, create threw) or its plugin is unavailable. DISABLED instances still have a live
   * object (a disabled push source must keep parsing so its events are stored with
   * `stage=source_disabled`); check the row's `enabled` column (or `instanceError(id) ===
   * 'disabled'`) for gating.
   */
  source(id: string): LiveSource | undefined;
  destination(id: string): LiveDestination | undefined;
  notifier(id: string): LiveNotifier | undefined;

  /** Why an instance has no live object (`plugin_unavailable`, `disabled`, `secret_error: ...`). */
  instanceError(id: string): string | undefined;

  /** Rebuild one instance from its current row (after a settings change or *Reload instance*). */
  reload(
    kind: 'source' | 'destination' | 'notifier' | 'secret_provider',
    id: string,
  ): Promise<void>;

  /** Attribute a plugin exception or an invalid event to its plugin (counted on the Plugins page). */
  recordPluginError(
    pluginName: string,
    kind: 'exception' | 'invalid_event' | 'invalid_usage',
    detail?: string,
  ): void;
}

function positiveSeconds(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * `LiveDestination.invokeTimeoutFor` for a type: the per-target value when the type declares one
 * and it is a positive number (a throw counts as no value), else the type's default.
 */
export function typeInvokeTimeout(type: DestinationType, target: unknown): number | undefined {
  let perTarget: unknown;
  try {
    perTarget = type.invokeTimeoutFor?.(target);
  } catch {
    perTarget = undefined;
  }
  return positiveSeconds(perTarget) ?? positiveSeconds(type.invokeTimeoutSeconds);
}
