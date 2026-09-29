import type { Health, JSONSchema, Settings } from './common.js';
import type { PluginContext } from './context.js';

export type NotificationTrigger = 'ok' | 'error' | 'held' | 'throttled' | 'system';

export interface NotificationMessage {
  on: NotificationTrigger;
  severity: 'info' | 'warning' | 'error';
  title: string;
  /** Rendered template text. */
  text: string;
  url?: string;
  fields?: Record<string, string>;
}

export interface Notifier {
  send(message: NotificationMessage): Promise<void>;
  health(): Promise<Health>;
}

export interface NotifierType {
  id: string;
  displayName: string;
  description?: string;
  /** A built-in icon name (`ICON_NAMES`) or a `data:image/svg+xml;base64,…` URI of at most 8 KB. */
  icon?: string;
  settingsSchema: JSONSchema;
  create(settings: Settings, ctx: PluginContext): Notifier;
}

/** Name only: never the value or anything derived from it (length, prefix, hash, preview). */
export interface SecretListing {
  /** The `<name>` in `secret://<provider>/<name>`; exactly what `resolve(name)` accepts. */
  name: string;
  /** Never a value. */
  description?: string;
  /** ISO-8601; when the backend knows it. */
  updatedAt?: string;
}

export interface SecretProvider {
  /** Throws if the secret does not exist. */
  resolve(name: string): Promise<string>;
  health(): Promise<Health>;
  /**
   * Names only, never values or any part of one; the conformance kit fails if a resolved value
   * appears anywhere in the listing. Providers that cannot enumerate omit this method.
   */
  list?(): Promise<SecretListing[]>;
  /**
   * A writable provider (SDK 2.2) implements both `set` and `delete`; the host stores rotated
   * instance credentials through them. `set` creates or replaces atomically; `delete` of a
   * missing name succeeds. Errors and logs never carry the value.
   */
  set?(name: string, value: string): Promise<void>;
  delete?(name: string): Promise<void>;
}

export interface SecretProviderType {
  id: string;
  displayName: string;
  description?: string;
  /** A built-in icon name (`ICON_NAMES`) or a `data:image/svg+xml;base64,…` URI of at most 8 KB. */
  icon?: string;
  settingsSchema: JSONSchema;
  create(settings: Settings, ctx: PluginContext): SecretProvider;
}
