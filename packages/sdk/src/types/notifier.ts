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
  /**
   * Optional (since SDK 1.3): the icon the UI shows for this type. Either a built-in icon name
   * (`ICON_NAMES`) or a `data:image/svg+xml;base64,…` URI of at most 8 KB, rendered through
   * `<img>`. Without one the UI shows the kind's generic icon.
   */
  icon?: string;
  settingsSchema: JSONSchema;
  create(settings: Settings, ctx: PluginContext): Notifier;
}

/**
 * One secret a provider makes available, as `SecretProvider.list()` reports it. It carries the
 * secret's **name only**: never its value, and nothing derived from the value (no length, prefix,
 * hash or preview). The UI shows these names next to the `secret://<provider>/<name>` reference
 * they form.
 */
export interface SecretListing {
  /** The `<name>` in `secret://<provider>/<name>`: exactly what `resolve(name)` accepts. */
  name: string;
  /** Optional human-readable note from the backend (a label or description). Never a value. */
  description?: string;
  /** ISO-8601 time the secret last changed, when the backend knows it. */
  updatedAt?: string;
}

export interface SecretProvider {
  /** Return the secret value for `name`, or throw if it does not exist. */
  resolve(name: string): Promise<string>;
  health(): Promise<Health>;
  /**
   * Optional (since SDK 1.1): the names of the secrets this provider can resolve, so an admin
   * can see what is available and which references are broken.
   *
   * **Names only, never values.** A listing must not contain a secret value, or any part or
   * derivative of one, in any field. The conformance kit (`secretProviderConformanceChecks`)
   * resolves every listed name and fails when a value appears anywhere in the listing.
   * Return only names `resolve` would accept. Providers that cannot enumerate omit this method.
   */
  list?(): Promise<SecretListing[]>;
}

export interface SecretProviderType {
  id: string;
  displayName: string;
  description?: string;
  /**
   * Optional (since SDK 1.3): the icon the UI shows for this type. Either a built-in icon name
   * (`ICON_NAMES`) or a `data:image/svg+xml;base64,…` URI of at most 8 KB, rendered through
   * `<img>`. Without one the UI shows the kind's generic icon.
   */
  icon?: string;
  settingsSchema: JSONSchema;
  create(settings: Settings, ctx: PluginContext): SecretProvider;
}
