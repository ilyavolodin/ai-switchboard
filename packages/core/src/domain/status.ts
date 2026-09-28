/**
 * The pipeline's outcome vocabulary. These strings are stored in Postgres, emitted as metric
 * attributes and shown in the UI, so they never change once released.
 */

/** Where an event stopped (or how far it got) at the door and at match. */
export const EVENT_STAGES = [
  'received',
  'matched',
  'unmatched',
  'source_disabled',
  'source_throttled',
  'type_muted',
  'event_invalid',
] as const;
export type EventStage = (typeof EVENT_STAGES)[number];

/** Why match did not evaluate a trigger on the event's source (stored in `events.match_decisions`). */
export const MATCH_SKIPS = ['process_disabled', 'trigger_disabled', 'type_not_subscribed'] as const;
export type MatchSkip = (typeof MATCH_SKIPS)[number];

export const DISPATCH_OUTCOMES = ['batched', 'deduped', 'filter_error'] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

export const BATCH_KINDS = ['event', 'sweep', 'manual'] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

/** `open` while collecting, then one terminal outcome. `awaiting_approval` re-enters the gate. */
export const BATCH_OUTCOMES = [
  'open',
  'closed',
  'held',
  'throttled',
  'awaiting_approval',
  'rejected',
  'invoked',
  'merged',
] as const;
export type BatchOutcome = (typeof BATCH_OUTCOMES)[number];

export const RUN_STATUSES = [
  'invoking',
  'running',
  'uncertain',
  'ok',
  'error',
  'failed',
  'unknown',
  'held',
] as const;
export type RunStatusValue = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: readonly RunStatusValue[] = [
  'ok',
  'error',
  'failed',
  'unknown',
  'held',
];
export const OPEN_RUN_STATUSES: readonly RunStatusValue[] = ['invoking', 'running', 'uncertain'];

/** Runs that count toward the breaker. */
export const BREAKER_RUN_STATUSES: readonly RunStatusValue[] = ['error', 'unknown'];

export function isTerminalRunStatus(s: RunStatusValue): boolean {
  return TERMINAL_RUN_STATUSES.includes(s);
}

/**
 * Hold reasons (gate stage). Stored in `batches.outcome_reason` as `<reason>` or `<reason>:<detail>`.
 */
export const HOLD_REASONS = [
  'process_disabled',
  'source_disabled',
  'executor_disabled',
  'executor_unhealthy',
  'plugin_unavailable',
  'breaker_open',
  'quiet_hours',
  'awaiting_approval',
  'paused',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** Binding limits (budget stage), stored in `batches.outcome_reason` (and the budget decision in `batches.decisions`). */
export type BindingLimit =
  | 'runs_per_hour'
  | 'runs_per_day'
  | 'executor_runs_per_hour'
  | 'executor_runs_per_day'
  | `usage_per_day:${string}`
  | `executor_usage_per_day:${string}`
  | `meter:${string}`
  | 'soft_hold';

export type StepPhase = 'before' | 'after';
/**
 * A step's journal state. A row is written `started` before the action runs and moved to `ok` or
 * `error` after; a row still `started` when the run is resumed is in doubt. An in-doubt `after`
 * step whose action is not idempotent is recorded `uncertain` (never repeated).
 */
export const STEP_STATUSES = ['started', 'ok', 'error', 'skipped', 'uncertain'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** A step status's tone: in doubt (`started`, `uncertain`) is a warning. */
export function stepTone(status: StepStatus): StatusTone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'error':
      return 'error';
    case 'started':
    case 'uncertain':
      return 'warn';
    case 'skipped':
      return 'off';
  }
}

export type ApprovalDecision = 'approved' | 'rejected';

export type Role = 'admin' | 'operator' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'operator', 'viewer'];

/** The UI's four-colour vocabulary. Every status maps to exactly one tone. */
export type StatusTone = 'ok' | 'warn' | 'error' | 'off';
