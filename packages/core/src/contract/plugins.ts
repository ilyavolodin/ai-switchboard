import type {
  ActionSpec,
  Capabilities,
  EventTypeSpec,
  JSONSchema,
  MeterSpec,
  TrackingMode,
  UsageDimension,
} from '@ai-switchboard/sdk';

import type { InstanceKind, PluginOrigin, PluginStatus } from '../domain/status.js';
import type { Iso, Reasoned, StatusLabel } from './common.js';
import { bodySchema } from './schema.js';

export type PluginKind = InstanceKind;

export interface PluginTypeDTO {
  kind: PluginKind;
  typeId: string;
  displayName: string;
  description?: string;
  /**
   * The icon the plugin declared (SDK 1.3): a built-in icon name (`ICON_NAMES`) or a
   * `data:image/svg+xml;base64,…` URI (render through `<img>` only). Absent: the kind's icon.
   */
  icon?: string;
  plugin: string;
  available: boolean;
  settingsSchema: JSONSchema;
  // sources
  mode?: 'push' | 'pull' | 'both';
  eventTypes?: EventTypeSpec[];
  dynamicEventTypes?: boolean;
  provisionSupported?: boolean;
  allowsUnauthenticated?: boolean;
  // destinations
  targetSchema?: JSONSchema;
  inputSchema?: JSONSchema;
  tracking?: TrackingMode;
  idempotentInvoke?: boolean;
  usage?: UsageDimension[];
  meters?: MeterSpec[];
  examples?: { target: unknown; input: unknown }[];
  actions?: ActionSpec[];
}

export interface PluginTypesQuery {
  kind?: PluginKind;
}

export interface PluginSummary {
  name: string;
  pluginId: string;
  displayName: string;
  version: string;
  status: PluginStatus;
  statusLabel: StatusLabel;
  statusMessage: string | null;
  origin: PluginOrigin;
  sdkRange: string;
  capabilities: Capabilities;
  types: { kind: PluginKind; typeId: string; displayName: string; instanceCount: number }[];
  errorCount: number;
  invalidEventCount: number;
  integrity: string | null;
  pendingRestart: boolean;
}

export interface InspectPluginRequest {
  package: string;
  range?: string;
}

export const inspectPluginBody = bodySchema<InspectPluginRequest>()({
  type: 'object',
  required: ['package'],
  properties: { package: { type: 'string' }, range: { type: 'string' } },
});

export interface InspectPluginResponse {
  package: string;
  version: string;
  sdkRange: string;
  compatible: boolean;
  capabilities: Capabilities;
  types: { kind: PluginKind; typeId: string; displayName: string }[];
  integrity: string | null;
}

export interface InstallPluginRequest extends Reasoned {
  package: string;
  range?: string;
}

export const installPluginBody = bodySchema<InstallPluginRequest>()({
  type: 'object',
  required: ['reason', 'package'],
  properties: {
    reason: { type: 'string' },
    package: { type: 'string' },
    range: { type: 'string' },
  },
});

/** The `{kind}` in the plugin naming convention `ai-switchboard-{kind}-{name}`. */
export type PluginSearchKind = 'source' | 'destination' | 'notifier' | 'secrets';

export interface PluginSearchQuery {
  kind?: PluginSearchKind;
  q?: string;
}

export interface PluginSearchResult {
  package: string;
  /** The instance kind its name promises. */
  kind: PluginKind;
  version: string;
  description: string;
  /** npm user who published the latest version. */
  publisher: string | null;
  date: Iso | null;
  links: { npm?: string; homepage?: string; repository?: string };
  weeklyDownloads: number | null;
  /** Loaded, or installed and waiting for a restart. */
  installed: boolean;
  installedVersion: string | null;
  /** In the project's catalogue of reviewed plugins. */
  reviewed: boolean;
}

export interface PluginSearchResponse {
  /** The registry that answered (`SWITCHBOARD_NPM_REGISTRY`). */
  registry: string;
  results: PluginSearchResult[];
}

export interface CatalogueEntry {
  package: string;
  displayName: string;
  description: string;
  kinds: PluginKind[];
  reviewed: boolean;
  installed: boolean;
  latestVersion: string;
  homepage?: string;
}
