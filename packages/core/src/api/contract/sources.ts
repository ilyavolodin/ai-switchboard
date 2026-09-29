import type {
  ActionSpec,
  ArtifactRef,
  Attributes,
  EventTypeSpec,
  Health,
  JSONSchema,
} from '@ai-switchboard/sdk';

import type { EventStage } from '../../domain/status.js';
import type { Iso, Reasoned, SecretRefDTO, StatsWindow, StatusLabel } from './common.js';
import { bodySchema } from './schema.js';

export interface SourceCapsDTO {
  eventCapPerHour?: number;
  eventCapPerDay?: number;
  eventTypesEnabled?: string[];
  pollIntervalSeconds?: number;
  unauthenticated?: boolean;
}

export const sourceCapsSchema = bodySchema<SourceCapsDTO>()({
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    eventCapPerHour: { type: 'integer', minimum: 0 },
    eventCapPerDay: { type: 'integer', minimum: 0 },
    eventTypesEnabled: { type: 'array', items: { type: 'string' } },
    pollIntervalSeconds: { type: 'integer', minimum: 10, maximum: 86_400 },
    unauthenticated: { type: 'boolean' },
  },
});

export interface SourceSummary {
  id: string;
  name: string;
  typeId: string;
  typeName: string;
  /** `null` when the type declares no icon or its plugin is not loaded. */
  typeIcon: string | null;
  mode: 'push' | 'pull' | 'both';
  enabled: boolean;
  status: StatusLabel;
  health: Health | null;
  lastEventAt: Iso | null;
  eventsByType24h: { type: string; count: number }[];
  pluginAvailable: boolean;
  unauthenticated: boolean;
  processCount: number;
}

export interface SourceDetail extends SourceSummary {
  settings: Record<string, unknown>;
  caps: SourceCapsDTO;
  webhookUrl: string | null;
  pollIntervalSeconds: number | null;
  provisionSupported: boolean;
  provisionedAt: Iso | null;
  secretRefs: SecretRefDTO[];
  eventTypes: EventTypeSpec[];
  actions: ActionSpec[];
  settingsSchema: JSONSchema;
  lastVerifyFailureAt: Iso | null;
  instanceError: string | null;
  processes: { id: string; name: string; eventTypes: string[] }[];
  createdAt: Iso;
  updatedAt: Iso;
}

export interface CreateSourceRequest extends Reasoned {
  typeId: string;
  name: string;
  settings: Record<string, unknown>;
  caps?: SourceCapsDTO;
  enabled?: boolean;
}

export const createSourceBody = bodySchema<CreateSourceRequest>()({
  type: 'object',
  required: ['reason', 'typeId', 'name', 'settings'],
  properties: {
    reason: { type: 'string' },
    typeId: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    settings: { type: 'object' },
    caps: { type: 'object' },
    enabled: { type: 'boolean' },
  },
});

export interface UpdateSourceRequest extends Reasoned {
  name?: string;
  settings?: Record<string, unknown>;
  caps?: SourceCapsDTO;
}

export const updateSourceBody = bodySchema<UpdateSourceRequest>()({
  type: 'object',
  required: ['reason'],
  properties: {
    reason: { type: 'string' },
    name: { type: 'string' },
    settings: { type: 'object' },
    caps: { type: 'object' },
  },
});

export interface TestEventRequest extends Reasoned {
  /** One of the source's declared event types; the first when omitted. */
  type?: string;
}

export const testEventBody = bodySchema<TestEventRequest>()({
  type: 'object',
  required: ['reason'],
  properties: { reason: { type: 'string' }, type: { type: 'string' } },
});

/** Replay and test events: the ids of the events it stored. */
export interface EventIdsResponse {
  eventIds: string[];
}

export interface SourceStatsResponse {
  window: StatsWindow;
  /** Hourly buckets. */
  buckets: {
    hour: Iso;
    byType: Record<string, number>;
    byStage: Partial<Record<EventStage, number>>;
  }[];
  verifyFailures: { hour: Iso; count: number }[];
}

/** A sample delivery for `POST /sources/preview`: the body as text, headers and query. */
export interface SampleDeliveryDTO {
  body: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface SourcePreviewRequest {
  /** A push (or both) source type. */
  typeId: string;
  /** Draft settings; secret fields hold `secret://` references, resolved server-side. */
  settings: Record<string, unknown>;
  /** The existing source being edited: secret fields left empty take its stored references. */
  sourceId?: string;
  request: SampleDeliveryDTO;
}

const stringMap = { type: 'object', additionalProperties: { type: 'string' } } as const;

export const sampleDeliverySchema = bodySchema<SampleDeliveryDTO>()({
  type: 'object',
  required: ['body'],
  properties: {
    body: { type: 'string', maxLength: 1_048_576 },
    headers: stringMap,
    query: stringMap,
  },
});

export const sourcePreviewBody = bodySchema<SourcePreviewRequest>()({
  type: 'object',
  required: ['typeId', 'settings', 'request'],
  properties: {
    typeId: { type: 'string', minLength: 1 },
    settings: { type: 'object' },
    sourceId: { type: 'string' },
    request: sampleDeliverySchema,
  },
});

/** One event the sample produced, checked against the instance's declared schemas. */
export interface SourcePreviewEvent {
  type: string;
  occurredAt: Iso;
  artifact: ArtifactRef;
  attributes: Attributes;
  dedupeKey: string;
  deliveryId?: string;
  /** False when the core would store it as `event_invalid`; `problems` says why. */
  valid: boolean;
  problems: string[];
}

export interface SourcePreviewResponse {
  events: SourcePreviewEvent[];
  /** Settings that do not build, a parse that threw, and invalid events, in words. */
  errors: string[];
  /** The plugin's notes on what produced no event and why (SDK 1.4 `parseWithNotes`). */
  notes: string[];
  declaredTypes: EventTypeSpec[];
}

/**
 * `GET /sources/:id/last-delivery`: the newest stored delivery (the query string is not
 * stored), with credential and signature headers redacted.
 */
export interface LastDeliveryResponse {
  receivedAt: Iso;
  body: string;
  headers: Record<string, string>;
}
