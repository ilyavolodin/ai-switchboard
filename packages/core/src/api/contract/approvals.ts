import type { ArtifactRef } from '@ai-switchboard/sdk';

import type { ApprovalDecision, BatchKind } from '../../domain/status.js';
import type { Iso } from './common.js';

export interface ApprovalItem {
  batchId: string;
  process: { id: string; name: string };
  rule: string;
  requestedAt: Iso;
  artifacts: ArtifactRef[];
  eventCount: number;
  kind: BatchKind;
  input: unknown;
}

export interface ApprovalHistoryItem extends ApprovalItem {
  /** `withdrawn`: the process was deleted while the request was pending. */
  decision: ApprovalDecision;
  decidedBy: string;
  decidedAt: Iso;
  reason: string;
}

export interface ApprovalRulesResponse {
  processes: { id: string; name: string; rule: string }[];
}

export interface ApprovalHistoryQuery {
  cursor?: string;
  limit?: number;
}

/** `POST /approvals/:batchId/approve`: the run it started, or why none started. */
export interface ApproveResponse {
  runId: string | null;
  outcome: string;
}
