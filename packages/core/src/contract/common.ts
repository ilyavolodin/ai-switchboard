import type {
  ActionSpec,
  ArtifactRef,
  Attributes,
  Capabilities,
  EventTypeSpec,
  Health,
  JSONSchema,
  MeterSpec,
  TrackingMode,
  UsageDimension,
  UsageReport,
} from '@ai-switchboard/sdk';

import type { StatusTone } from '../domain/status.js';
import { bodySchema } from './schema.js';

export type { ProcessDocument } from '../domain/process.js';
export type {
  Trigger,
  Schedule,
  Step,
  Notification,
  QuietWindow,
  MeterCeiling,
} from '../domain/process.js';
export type {
  ApprovalState,
  BatchKind,
  BatchOutcome,
  BreakerStateValue,
  EventStage,
  InstanceKind,
  NotifyOn,
  PluginOrigin,
  PluginStatus,
  Role,
  RunStatusValue,
  SettledRunStatus,
  StatusTone,
  StepStatus,
} from '../domain/status.js';
export type { GlobalSettings, RetentionSettings } from '../domain/settings.js';
export type {
  ArtifactRef,
  Attributes,
  EventTypeSpec,
  Health,
  JSONSchema,
  MeterSpec,
  UsageDimension,
  UsageReport,
  ActionSpec,
  Capabilities,
  TrackingMode,
};

export type Iso = string;

export interface ApiError {
  error: string;
  message: string;
  details?: string[];
  /** On a 409 for deleting an instance still in use: the processes using it. */
  usedBy?: { id: string; name: string }[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** An empty reason is a 400 unless `requireReasons` is off. */
export interface Reasoned {
  reason: string;
}

export const reasonedBody = bodySchema<Reasoned>()({
  type: 'object',
  required: ['reason'],
  properties: { reason: { type: 'string' } },
});

export interface EnableRequest extends Reasoned {
  enabled: boolean;
}

export const enableBody = bodySchema<EnableRequest>()({
  type: 'object',
  required: ['reason', 'enabled'],
  properties: { reason: { type: 'string' }, enabled: { type: 'boolean' } },
});

/** A status word plus its tone in the four-colour vocabulary. Always shown with its label. */
export interface StatusLabel {
  tone: StatusTone;
  label: string;
}

/** The outcome of a one-off call to a plugin (register a webhook, send a test notification). */
export interface ResultResponse {
  ok: boolean;
  message: string;
}

export interface SecretRefDTO {
  field: string;
  ref: string;
  lastResolvedAt: Iso | null;
  ok: boolean;
  error?: string;
}

export type { StatsWindow } from '../domain/status.js';
import type { StatsWindow } from '../domain/status.js';

export interface WindowQuery {
  window?: StatsWindow;
}
