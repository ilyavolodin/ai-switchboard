import type { HttpClient } from '../http.js';
import type { Logger } from '../logger.js';

/** Small durable key/value store scoped to one instance (e.g. an OAuth refresh token). */
export interface InstanceState {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** Everything the core hands a plugin when it creates an instance. */
export interface PluginContext {
  instanceId: string;
  instanceName: string;
  logger: Logger;
  /** Honours the plugin's declared network capability and propagates tracing. */
  http: HttpClient;
  /** The core's clock; use it instead of `Date.now()` so tests can control time. */
  now(): Date;
  /** Public base URL of this installation, e.g. `https://switchboard.example.com`. */
  publicUrl: string;
  state: InstanceState;
}
