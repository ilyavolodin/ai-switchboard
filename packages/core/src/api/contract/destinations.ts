import type {
  ActionSpec,
  Health,
  JSONSchema,
  MeterSpec,
  TrackingMode,
  UsageDimension,
} from '@ai-switchboard/sdk';

import type { RunStatusValue } from '../../domain/status.js';
import type { Iso, Reasoned, SecretRefDTO, StatsWindow, StatusLabel } from './common.js';
import { bodySchema } from './schema.js';

export interface DestinationCapsDTO {
  runsPerHour?: number;
  runsPerDay?: number;
  usagePerDay?: Record<string, number>;
  meterPollSeconds?: number;
  meterStalenessMinutes?: number;
  estimatedLimits?: Record<string, number>;
  /**
   * 1–3600 s. Overrides the type's per-target and default timeouts (core default 300 s). No answer
   * in time is a lost response.
   */
  invokeTimeoutSeconds?: number;
}

export const destinationCapsSchema = bodySchema<DestinationCapsDTO>()({
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    runsPerHour: { type: 'integer', minimum: 0 },
    runsPerDay: { type: 'integer', minimum: 0 },
    usagePerDay: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
    meterPollSeconds: { type: 'integer', minimum: 30, maximum: 86_400 },
    meterStalenessMinutes: { type: 'integer', minimum: 1, maximum: 10_080 },
    estimatedLimits: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
    invokeTimeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
  },
});

/**
 * Where the meter stands against the event ceilings of the processes bound to it, as the budget
 * stage decides it: `throttling` when an event batch would be throttled now, `stale` when a
 * ceiling is set but the reading is missing or too old to apply.
 */
export type CeilingState = 'below' | 'throttling' | 'stale';

export interface MeterGaugeDTO {
  destinationId: string;
  destinationName: string;
  meterId: string;
  title: string;
  kind: MeterSpec['kind'];
  unit: string;
  utilization: number | null;
  used: number | null;
  limit: number | null;
  resetsAt: Iso | null;
  observedAt: Iso | null;
  estimated: boolean;
  stale: boolean;
  /** Process ceilings bound to this meter, for marks on the gauge. */
  ceilings: { processId: string; processName: string; events: number; sweeps: number }[];
  ceilingState: CeilingState;
  primary: boolean;
}

export interface DestinationSummary {
  id: string;
  name: string;
  typeId: string;
  typeName: string;
  typeIcon: string | null;
  enabled: boolean;
  status: StatusLabel;
  health: Health | null;
  meters: MeterGaugeDTO[];
  softHoldUntil: Iso | null;
  softHoldReason: string | null;
  pluginAvailable: boolean;
  runs24h: number;
  processCount: number;
}

export interface DestinationDetail extends DestinationSummary {
  settings: Record<string, unknown>;
  targetDefaults: Record<string, unknown>;
  caps: DestinationCapsDTO;
  settingsSchema: JSONSchema;
  targetSchema: JSONSchema;
  inputSchema: JSONSchema;
  tracking: TrackingMode;
  idempotentInvoke: boolean;
  usage: UsageDimension[];
  meterSpecs: MeterSpec[];
  actions: ActionSpec[];
  callbackUrl: string;
  secretRefs: SecretRefDTO[];
  instanceError: string | null;
  processes: { id: string; name: string }[];
  createdAt: Iso;
  updatedAt: Iso;
}

export interface CreateDestinationRequest extends Reasoned {
  typeId: string;
  name: string;
  settings: Record<string, unknown>;
  targetDefaults?: Record<string, unknown>;
  caps?: DestinationCapsDTO;
  enabled?: boolean;
}

export const createDestinationBody = bodySchema<CreateDestinationRequest>()({
  type: 'object',
  required: ['reason', 'typeId', 'name', 'settings'],
  properties: {
    reason: { type: 'string' },
    typeId: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    settings: { type: 'object' },
    targetDefaults: { type: 'object' },
    caps: { type: 'object' },
    enabled: { type: 'boolean' },
  },
});

export interface UpdateDestinationRequest extends Reasoned {
  name?: string;
  settings?: Record<string, unknown>;
  targetDefaults?: Record<string, unknown>;
  caps?: DestinationCapsDTO;
}

export const updateDestinationBody = bodySchema<UpdateDestinationRequest>()({
  type: 'object',
  required: ['reason'],
  properties: {
    reason: { type: 'string' },
    name: { type: 'string' },
    settings: { type: 'object' },
    targetDefaults: { type: 'object' },
    caps: { type: 'object' },
  },
});

export interface MeterHistoryResponse {
  window: StatsWindow;
  meters: {
    id: string;
    title: string;
    estimated: boolean;
    readings: { t: Iso; utilization: number; resetsAt: Iso | null }[];
    ceilings: MeterGaugeDTO['ceilings'];
  }[];
  runs: {
    t: Iso;
    runId: string;
    processId: string;
    processName: string;
    status: RunStatusValue;
    statusLabel: StatusLabel;
  }[];
}

export interface UsageHistoryResponse {
  window: StatsWindow;
  dimensions: { id: string; title: string; unit: string; days: { day: Iso; value: number }[] }[];
  runsByStatus: { day: Iso; counts: Partial<Record<RunStatusValue, number>> }[];
}
