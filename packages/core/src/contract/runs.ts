import type { ArtifactRef, UsageReport } from '@ai-switchboard/sdk';

import {
  SETTLED_RUN_STATUSES,
  type BatchKind,
  type RunStatusValue,
  type SettledRunStatus,
  type StepStatus,
} from '../domain/status.js';
import type { Iso, Reasoned, StatusLabel } from './common.js';
import { bodySchema } from './schema.js';

export interface RunSummary {
  id: string;
  processId: string;
  processName: string;
  destinationId: string;
  destinationName: string;
  kind: BatchKind;
  status: RunStatusValue;
  statusLabel: StatusLabel;
  statusReason: string | null;
  externalId: string | null;
  externalUrl: string | null;
  usage: UsageReport | null;
  dryRun: boolean;
  invokedAt: Iso | null;
  finishedAt: Iso | null;
  durationSeconds: number | null;
  eventCount: number;
  artifacts: ArtifactRef[];
}

export interface RunDetail extends RunSummary {
  batchId: string;
  /** Manual runs (Run now, test runs): who asked for it. Null for event runs and sweeps. */
  requestedBy: string | null;
  input: unknown;
  result: unknown;
  errors: string[];
  steps: {
    phase: 'before' | 'after';
    index: number;
    providerId: string;
    action: string;
    args: unknown;
    /**
     * `started` (running now, or in doubt when the run moved on), `ok`, `error`, `skipped`, or
     * `uncertain` (in doubt after an interrupted attempt; a non-idempotent action is not repeated).
     */
    status: StepStatus;
    error: string | null;
    at: Iso;
  }[];
  updates: { at: Iso; source: string; status: RunStatusValue; detail: unknown }[];
}

export interface RunsQuery {
  process?: string;
  destination?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

export interface CloseRunRequest extends Reasoned {
  status: SettledRunStatus;
}

export const closeRunBody = bodySchema<CloseRunRequest>()({
  type: 'object',
  required: ['reason', 'status'],
  properties: {
    reason: { type: 'string' },
    status: { type: 'string', enum: SETTLED_RUN_STATUSES },
  },
});
