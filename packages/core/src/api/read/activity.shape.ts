import type { ActivityRow, StageIndicator } from '../../contract/index.js';
import type { events } from '../../db/schema.js';
import { runStatusLabel } from '../../domain/labels.js';
import { toneRank, type BatchOutcome, type RunStatusValue } from '../../domain/status.js';

export type EventRow = typeof events.$inferSelect;

/** One process's handling of an event: its dispatch, the batch it joined and the run, if any. */
export interface DispatchInfo {
  processId: string;
  processName: string;
  outcome: string;
  batchOutcome: BatchOutcome | null;
  batchReason: string | null;
  runId: string | null;
  runStatus: RunStatusValue | null;
}

const DOOR_STOPS: Record<string, StageIndicator> = {
  unmatched: { reached: 1, tone: 'off', label: 'no process wants it' },
  source_disabled: { reached: 1, tone: 'off', label: 'source disabled' },
  source_throttled: { reached: 1, tone: 'warn', label: 'source throttled' },
  type_muted: { reached: 1, tone: 'off', label: 'type muted' },
  event_invalid: { reached: 1, tone: 'error', label: 'invalid event' },
  received: { reached: 1, tone: 'ok', label: 'received' },
};

const withReason = (word: string, reason: string | null) => (reason ? `${word} · ${reason}` : word);

function dispatchIndicator(d: DispatchInfo): StageIndicator {
  if (d.outcome === 'deduped') return { reached: 2, tone: 'off', label: 'deduped' };
  if (d.outcome === 'filter_error') return { reached: 2, tone: 'error', label: 'filter error' };
  if (d.runStatus)
    return { reached: 5, tone: runStatusLabel(d.runStatus).tone, label: d.runStatus };
  switch (d.batchOutcome) {
    case 'held':
    case 'throttled':
      return { reached: 3, tone: 'warn', label: withReason(d.batchOutcome, d.batchReason) };
    case 'awaiting_approval':
      return { reached: 3, tone: 'warn', label: 'awaiting approval' };
    case 'rejected':
      return { reached: 3, tone: 'off', label: 'rejected' };
    case 'invoked':
    case 'merged':
      return { reached: 4, tone: 'ok', label: 'gated' };
    case null:
    case 'open':
    case 'closed':
      return { reached: 3, tone: 'ok', label: 'batched' };
  }
}

/** How far an event got: received → matched → batched → gated → invoked, and in what tone. */
export function indicatorFor(stage: string, ds: readonly DispatchInfo[]): StageIndicator {
  if (ds.length === 0) return DOOR_STOPS[stage] ?? { reached: 1, tone: 'ok', label: stage };
  // Show the furthest-reaching dispatch; on a tie, the worse tone.
  return (
    ds
      .map(dispatchIndicator)
      .sort((a, b) => b.reached - a.reached || toneRank(a.tone) - toneRank(b.tone))[0] ?? {
      reached: 1,
      tone: 'ok',
      label: 'received',
    }
  );
}

export function activityRow(
  e: EventRow,
  dispatched: readonly DispatchInfo[],
  sourceName: string,
  whyNothingRan: string | null,
): ActivityRow {
  return {
    eventId: e.id,
    sourceId: e.sourceId,
    sourceName,
    type: e.type,
    occurredAt: e.occurredAt.toISOString(),
    receivedAt: e.receivedAt.toISOString(),
    artifact: e.artifact,
    stage: e.stage,
    indicator: indicatorFor(e.stage, dispatched),
    processes: dispatched.map((d) => ({
      id: d.processId,
      name: d.processName,
      outcome: d.batchOutcome ?? d.outcome,
      runId: d.runId,
      runStatus: d.runStatus,
      statusLabel: d.runStatus ? runStatusLabel(d.runStatus) : null,
    })),
    replayOf: e.replayOf,
    whyNothingRan,
  };
}

const RAW_LIMIT = 64 * 1024;

/** Header names that can carry a credential: API keys, passwords, tokens, signatures, cookies. */
const CREDENTIAL_HEADER = /auth|cookie|secret|token|signature|api-?key|password|credential/i;

export function safeHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADER.test(k)));
}

/** A stored raw body for display: credential headers dropped, the body cut at 64 KiB. */
export function rawPreview(raw: { headers: Record<string, string | undefined>; body: Buffer }) {
  return {
    headers: safeHeaders(raw.headers),
    body: raw.body.subarray(0, RAW_LIMIT).toString('utf8'),
    truncated: raw.body.length > RAW_LIMIT,
  };
}
