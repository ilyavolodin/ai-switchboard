import type { HttpClient } from '../http.js';
import type { Logger } from '../logger.js';

/**
 * Small durable key/value store scoped to one instance, kept in Postgres. Never put a credential
 * here (the host refuses values it knows are secret); use `ctx.secrets` instead.
 */
export interface InstanceState {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export type SecretStoreStatus =
  { writable: true; provider: string } | { writable: false; reason: string };

/**
 * Credentials an instance rotates at run time (an OAuth refresh token), scoped to the instance.
 * The host keeps them in a writable secret provider the instance's settings already reference,
 * never in Postgres. Keys match `SECRET_KEY_PATTERN`. `set` and `delete` throw
 * `SecretStoreError` when no referenced provider is writable; `check()` says so up front.
 */
export interface InstanceSecrets {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  check(): Promise<SecretStoreStatus>;
}

export interface PluginContext {
  instanceId: string;
  instanceName: string;
  logger: Logger;
  /** Honours the plugin's declared network capability and propagates tracing. */
  http: HttpClient;
  /** Use instead of `Date.now()` so tests can control time. */
  now(): Date;
  /** Public base URL of this installation. */
  publicUrl: string;
  state: InstanceState;
  /** SDK 2.2. */
  secrets: InstanceSecrets;
}
