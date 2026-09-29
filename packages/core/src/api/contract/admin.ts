import type { GlobalSettings, RetentionSettings } from '../../domain/settings.js';
import type { Iso, Reasoned } from './common.js';
import { bodySchema } from './schema.js';

export interface UpdateSettingsRequest extends Reasoned {
  settings: Partial<GlobalSettings>;
}

const hhmm = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' } as const;
const nullableString = { anyOf: [{ type: 'null' }, { type: 'string' }] } as const;

export const retentionSchema = bodySchema<Partial<RetentionSettings>>()({
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    eventsDays: { type: 'integer', minimum: 1 },
    rawBodiesDays: { type: 'integer', minimum: 1 },
    dispatchesDays: { type: 'integer', minimum: 1 },
    meterReadingsDays: { type: 'integer', minimum: 1 },
    statsHourlyDays: { type: 'integer', minimum: 1 },
  },
});

export const exportSettingsSchema = bodySchema<Partial<GlobalSettings['export']>>()({
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    schedule: nullableString,
    sourceId: nullableString,
    repository: nullableString,
    path: nullableString,
    branch: nullableString,
  },
});

/** A partial `GlobalSettings`: what `PUT /settings` merges into the stored settings. */
export const settingsPatchSchema = bodySchema<Partial<GlobalSettings>>()({
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    timezone: { type: 'string', minLength: 1 },
    defaultQuietHours: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['start', 'end'],
          additionalProperties: false,
          properties: {
            start: hhmm,
            end: hhmm,
            days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 } },
          },
        },
      ],
    },
    meterStalenessMinutes: { type: 'integer', minimum: 1, maximum: 10_080 },
    retention: retentionSchema,
    oidc: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['issuer', 'clientId', 'allowedDomains'],
          properties: {
            issuer: { type: 'string' },
            clientId: { type: 'string' },
            allowedDomains: { type: 'array', items: { type: 'string' } },
          },
        },
      ],
    },
    systemNotifierId: nullableString,
    sourceSilenceMinutes: { type: 'integer', minimum: 1 },
    requireReasons: { type: 'boolean' },
    export: exportSettingsSchema,
  },
});

export const updateSettingsBody = bodySchema<UpdateSettingsRequest>()({
  type: 'object',
  required: ['reason', 'settings'],
  properties: { reason: { type: 'string' }, settings: { type: 'object' } },
});

export interface AuditEntry {
  id: number;
  at: Iso;
  actor: string;
  scope: string;
  targetId: string | null;
  targetName: string | null;
  field: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface AuditQuery {
  scope?: string;
  target?: string;
  actor?: string;
  cursor?: string;
  limit?: number;
}

export interface ApplyRequest extends Reasoned {
  yaml: string;
  dryRun?: boolean;
}

export const applyBody = bodySchema<ApplyRequest>()({
  type: 'object',
  required: ['reason', 'yaml'],
  properties: { reason: { type: 'string' }, yaml: { type: 'string' }, dryRun: { type: 'boolean' } },
});

export interface ApplyResponse {
  dryRun: boolean;
  changes: { kind: string; name: string; action: 'create' | 'update' | 'unchanged' | 'delete' }[];
  errors: string[];
}

export interface AboutResponse {
  version: string;
  sdkVersion: string;
  replicas: {
    id: string;
    hostname: string;
    version: string;
    startedAt: Iso;
    heartbeatAt: Iso;
    live: boolean;
  }[];
  database: { ok: boolean; version: string | null };
  plugins: number;
  evaluation: boolean;
  publicUrl: string;
  /** Where this replica sends OpenTelemetry signals. Header names and values are never shown. */
  telemetry: TelemetryStatusDTO;
}

export interface TelemetryStatusDTO {
  /** False when `OTEL_SDK_DISABLED` is set. */
  enabled: boolean;
  serviceName: string;
  /** Prometheus exposition served at `GET /metrics`. */
  prometheus: boolean;
  signals: {
    signal: 'traces' | 'metrics' | 'logs';
    /** Empty when the signal is not exported. */
    exporters: ('otlp' | 'console')[];
    protocol: 'http/protobuf' | 'http/json' | 'grpc' | null;
    /** `scheme://host:port` of the OTLP endpoint (no path, query or credentials). */
    endpoint: string | null;
    /** How many export headers are configured (e.g. a vendor API key). */
    headers: number;
  }[];
  /** `OTEL_TRACES_SAMPLER`, with its ratio when it has one. */
  sampler: string;
}
