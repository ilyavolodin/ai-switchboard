import type { HttpClient } from '../http.js';
import type { Logger } from '../logger.js';

/** Small durable key/value store scoped to one instance (e.g. an OAuth refresh token). */
export interface InstanceState {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
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
}
