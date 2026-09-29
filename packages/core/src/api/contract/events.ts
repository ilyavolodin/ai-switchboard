import type { ArtifactRef, Attributes } from '@ai-switchboard/sdk';

import type { EventStage, RunStatusValue, StatusTone } from '../../domain/status.js';
import type { Iso, StatusLabel } from './common.js';

/** Five stops: received → matched → batched → gated → invoked; `reached` is how far it got. */
export interface StageIndicator {
  reached: 0 | 1 | 2 | 3 | 4 | 5;
  tone: StatusTone;
  label: string;
}

export interface ActivityRow {
  eventId: string;
  sourceId: string;
  sourceName: string;
  type: string;
  occurredAt: Iso;
  receivedAt: Iso;
  artifact: ArtifactRef;
  stage: EventStage;
  indicator: StageIndicator;
  processes: {
    id: string;
    name: string;
    outcome: string;
    runId: string | null;
    runStatus: RunStatusValue | null;
    /** The run status in words and tone; null while no run exists. */
    statusLabel: StatusLabel | null;
  }[];
  replayOf: string | null;
  /**
   * For an `unmatched` event, one line saying why nothing ran: the most actionable process reason
   * (`Autofix: process is disabled (+1 more)`) or `no process has a trigger on this source`.
   * Null otherwise. `GET /events/:id` has the full list in `explanations`.
   */
  whyNothingRan: string | null;
}

export interface ActivityQuery {
  source?: string;
  process?: string;
  destination?: string;
  stage?: string;
  /** Exact event type, e.g. `github.pull_request.labeled`. */
  type?: string;
  artifact?: string;
  from?: Iso;
  to?: Iso;
  cursor?: string;
  limit?: number;
}

/**
 * `basis: 'recorded'` is what was recorded when the event arrived; `'now'` is computed from the
 * current configuration because nothing was recorded for that process.
 */
export interface EventExplanation {
  processId: string;
  processName: string;
  taken: boolean;
  reason: string;
  basis: 'recorded' | 'now';
  tone: 'ok' | 'warn' | 'off';
}

export interface EventDetail extends ActivityRow {
  attributes: Attributes;
  dedupeKey: string;
  deliveryId: string | null;
  stageReason: string | null;
  /** One per process with a trigger on the event's source (empty while the event is `received`). */
  explanations: EventExplanation[];
  raw: { headers: Record<string, string | undefined>; body: string; truncated: boolean } | null;
}

export type TraceEntryKind =
  | 'event'
  | 'filter'
  | 'dedupe'
  | 'batch_open'
  | 'batch_join'
  | 'batch_close'
  | 'gate'
  | 'budget'
  | 'approval'
  | 'step'
  | 'invoke'
  | 'tracking'
  | 'terminal'
  | 'notification';

export interface TraceEntry {
  at: Iso;
  kind: TraceEntryKind;
  tone: StatusTone;
  title: string;
  detail?: string;
  /** Expression + result, meter readings, counters, etc. */
  data?: Record<string, unknown>;
  eventId?: string;
  processId?: string;
  processName?: string;
  batchId?: string;
  runId?: string;
  externalUrl?: string;
}

export interface TraceResponse {
  query: string;
  artifacts: ArtifactRef[];
  entries: TraceEntry[];
  /** The same timeline as copyable plain text. */
  text: string;
}

export interface TraceQuery {
  artifact?: string;
}
