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
  settingsSchema: JSONSchema;
  create(settings: Settings, ctx: PluginContext): Notifier;
}

export interface SecretProvider {
  /** Return the secret value for `name`, or throw if it does not exist. */
  resolve(name: string): Promise<string>;
  health(): Promise<Health>;
}

export interface SecretProviderType {
  id: string;
  displayName: string;
  description?: string;
  settingsSchema: JSONSchema;
  create(settings: Settings, ctx: PluginContext): SecretProvider;
}
