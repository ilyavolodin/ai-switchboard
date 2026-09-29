// These strings are stored in Postgres and emitted as metric attributes: never change them once
// released.

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

/** How a stored raw body arrived: a push delivery, a pull source's page, or an injected test event. */
export const RAW_ORIGINS = ['push', 'poll', 'test'] as const;
export type RawOrigin = (typeof RAW_ORIGINS)[number];

export const MATCH_SKIPS = ['process_disabled', 'trigger_disabled', 'type_not_subscribed'] as const;
export type MatchSkip = (typeof MATCH_SKIPS)[number];

export const DISPATCH_OUTCOMES = ['batched', 'deduped', 'filter_error'] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

export const BATCH_KINDS = ['event', 'sweep', 'manual'] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

/** `awaiting_approval` re-enters the gate. */
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

export const BREAKER_RUN_STATUSES: readonly RunStatusValue[] = ['error', 'unknown'];

/** Invoked runs that tracking still has to settle. */
export const TRACKED_RUN_STATUSES = [
  'running',
  'uncertain',
] as const satisfies readonly RunStatusValue[];
export type TrackedRunStatus = (typeof TRACKED_RUN_STATUSES)[number];

/** The statuses a tracked run can be settled to, by a destination or by hand. */
export const SETTLED_RUN_STATUSES = [
  'ok',
  'error',
  'unknown',
] as const satisfies readonly RunStatusValue[];
export type SettledRunStatus = (typeof SETTLED_RUN_STATUSES)[number];

export function isSettledRunStatus(s: string): s is SettledRunStatus {
  return (SETTLED_RUN_STATUSES as readonly string[]).includes(s);
}

export function isTerminalRunStatus(s: RunStatusValue): boolean {
  return TERMINAL_RUN_STATUSES.includes(s);
}

/** Stored in `batches.outcome_reason` as `<reason>` or `<reason>:<detail>`. */
export const HOLD_REASONS = [
  'process_disabled',
  'source_disabled',
  'destination_disabled',
  'destination_unhealthy',
  'plugin_unavailable',
  'breaker_open',
  'quiet_hours',
  'awaiting_approval',
  'paused',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export type BindingLimit =
  | 'runs_per_hour'
  | 'runs_per_day'
  | 'destination_runs_per_hour'
  | 'destination_runs_per_day'
  | `usage_per_day:${string}`
  | `destination_usage_per_day:${string}`
  | `meter:${string}`
  | 'soft_hold';

export type StepPhase = 'before' | 'after';
/**
 * A row still `started` when the run is resumed is in doubt. An in-doubt `after` step whose
 * action is not idempotent is recorded `uncertain` (never repeated).
 */
export const STEP_STATUSES = ['started', 'ok', 'error', 'skipped', 'uncertain'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

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

/** `withdrawn`: the process was deleted while the approval was pending. */
export type ApprovalDecision = 'approved' | 'rejected' | 'withdrawn';

export const APPROVAL_STATES = ['none', 'pending', 'approved', 'rejected'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const BREAKER_STATES = ['open', 'closed'] as const;
export type BreakerStateValue = (typeof BREAKER_STATES)[number];

export const NOTIFY_ON = ['ok', 'error', 'held', 'throttled'] as const;
export type NotifyOn = (typeof NOTIFY_ON)[number];

export const ROLES = ['admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2 };

export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export const INSTANCE_KINDS = ['source', 'destination', 'notifier', 'secret_provider'] as const;
export type InstanceKind = (typeof INSTANCE_KINDS)[number];

/** `plugins.status`. */
export const PLUGIN_STATUSES = ['loaded', 'unavailable', 'failed', 'incompatible'] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/** `baked` (image node_modules) or `installed` ($SWITCHBOARD_HOME/plugins). */
export const PLUGIN_ORIGINS = ['baked', 'installed'] as const;
export type PluginOrigin = (typeof PLUGIN_ORIGINS)[number];

export type StatusTone = 'ok' | 'warn' | 'error' | 'off';
