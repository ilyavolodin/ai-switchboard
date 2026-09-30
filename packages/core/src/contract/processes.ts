import type { ArtifactRef, Attributes } from '@ai-switchboard/sdk';

import type { ProcessDocument } from '../domain/process.js';
import type {
  BatchKind,
  BatchOutcome,
  BreakerStateValue,
  RunStatusValue,
} from '../domain/status.js';
import type { PipelineDots } from './board.js';
import {
  limitParam,
  type Iso,
  type Reasoned,
  type StatsWindow,
  type StatusLabel,
} from './common.js';
import type { RunSummary } from './runs.js';
import { bodySchema, querySchema } from './schema.js';

export interface ProcessSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: StatusLabel;
  breakerState: BreakerStateValue;
  awaitingApproval: number;
  dots: PipelineDots;
  /** Runs per day, last 7 days, oldest first. */
  sparkline: number[];
  nextSweepAt: Iso | null;
  dailyCap: { used: number; limit: number | null };
  lastRunAt: Iso | null;
  destination: { id: string; name: string } | null;
  triggers: { sourceId: string; sourceName: string; describe: string; eventTypes: string[] }[];
  updatedAt: Iso;
}

export interface ProcessDetail {
  id: string;
  name: string;
  document: ProcessDocument;
  enabled: boolean;
  status: StatusLabel;
  breakerState: BreakerStateValue;
  breakerOpenedAt: Iso | null;
  /** When breaker is open: the last failed runs. */
  recentFailures: RunSummary[];
  version: number;
  nextSweepAt: Iso | null;
  awaitingApproval: number;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface CreateProcessRequest extends Reasoned {
  document: ProcessDocument;
}

export const createProcessBody = bodySchema<CreateProcessRequest>()({
  type: 'object',
  required: ['reason', 'document'],
  properties: { reason: { type: 'string' }, document: { type: 'object' } },
});

export interface UpdateProcessRequest extends Reasoned {
  document: ProcessDocument;
  /** Optimistic concurrency: 409 when the stored version differs. */
  expectedVersion: number;
}

export const updateProcessBody = bodySchema<UpdateProcessRequest>()({
  type: 'object',
  required: ['reason', 'document', 'expectedVersion'],
  properties: {
    reason: { type: 'string' },
    document: { type: 'object' },
    expectedVersion: { type: 'integer' },
  },
});

export interface RunNowRequest extends Reasoned {
  dryRun?: boolean;
  /** Test run with the events of a recent batch. */
  batchId?: string;
}

export const runNowBody = bodySchema<RunNowRequest>()({
  type: 'object',
  required: ['reason'],
  properties: {
    reason: { type: 'string' },
    dryRun: { type: 'boolean' },
    batchId: { type: 'string' },
  },
});

export interface RunNowResponse {
  batchId: string;
  /** Null when the run did not start (held, throttled, awaiting approval, or a dry run). */
  runId: string | null;
  outcome: string;
}

export interface FunnelResponse {
  window: StatsWindow;
  event: {
    received: number;
    /** Dispatches (event × process) that matched a trigger, whatever happened next. */
    matched: number;
    /** Of those, dropped as duplicates (the funnel's "after dedupe" is `matched - deduped`). */
    deduped: number;
    batched: number;
    batches: number;
    held: number;
    throttled: number;
    invoked: number;
    ok: number;
    error: number;
    failed: number;
    unknown: number;
    running: number;
  };
  sweep: {
    fired: number;
    held: number;
    throttled: number;
    invoked: number;
    ok: number;
    error: number;
  };
}

export interface ProcessStatsResponse {
  window: StatsWindow;
  days: {
    day: Iso;
    runs: Partial<Record<RunStatusValue, number>>;
    throttled: number;
    held: number;
    latencyP50Seconds: number | null;
    durationP50Seconds: number | null;
  }[];
  usagePerRun: {
    dimension: string;
    title: string;
    unit: string;
    average: number | null;
    total: number;
  }[];
}

export interface ProcessVersionSummary {
  version: number;
  savedBy: string;
  savedAt: Iso;
  reason: string;
}

export interface ProcessVersionDetail extends ProcessVersionSummary {
  document: ProcessDocument;
}

export interface FilterPreviewRequest {
  sourceId: string;
  eventTypes: string[];
  filter?: string;
  /** Default 20. */
  limit?: number;
}

export const filterPreviewBody = bodySchema<FilterPreviewRequest>()({
  type: 'object',
  required: ['sourceId', 'eventTypes'],
  properties: {
    sourceId: { type: 'string' },
    eventTypes: { type: 'array', items: { type: 'string' } },
    filter: { type: 'string' },
    limit: { type: 'integer', minimum: 1 },
  },
});

export interface FilterPreviewResponse {
  rows: {
    eventId: string;
    type: string;
    occurredAt: Iso;
    artifact: ArtifactRef;
    attributes: Attributes;
    result: boolean;
    error?: string;
  }[];
}

export interface InputPreviewRequest {
  document: ProcessDocument;
  /** A recent batch to feed the mapping; omitted = the example sweep context. */
  batchId?: string;
  mode?: 'event' | 'sweep';
}

export const inputPreviewBody = bodySchema<InputPreviewRequest>()({
  type: 'object',
  required: ['document'],
  properties: {
    document: { type: 'object' },
    batchId: { type: 'string' },
    mode: { type: 'string', enum: ['event', 'sweep'] },
  },
});

export interface InputPreviewResponse {
  input: unknown;
  valid: boolean;
  errors: string[];
}

export interface CronPreviewRequest {
  cron: string;
  timezone: string;
}

export const cronPreviewBody = bodySchema<CronPreviewRequest>()({
  type: 'object',
  required: ['cron', 'timezone'],
  properties: { cron: { type: 'string' }, timezone: { type: 'string' } },
});

export interface CronPreviewResponse {
  valid: boolean;
  description: string;
  next: Iso[];
  error?: string;
}

export interface RecentBatchDTO {
  id: string;
  kind: BatchKind;
  openedAt: Iso;
  size: number;
  outcome: BatchOutcome;
  artifacts: ArtifactRef[];
}

export interface LimitQuery {
  limit?: number;
}

export const limitQuery = querySchema<LimitQuery>()({
  type: 'object',
  properties: { limit: limitParam },
});
