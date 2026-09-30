import { PLUGIN_KINDS, RUN_STATES } from '@ai-switchboard/sdk/constants';
import { isOneOf } from '@ai-switchboard/sdk/json';

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

/** Stages that count against a source's event caps. */
export const ACCEPTED_STAGES = [
  'received',
  'matched',
  'unmatched',
] as const satisfies readonly EventStage[];

/** How a stored raw body arrived: a push delivery, a pull source's page, or an injected test event. */
export const RAW_ORIGINS = ['push', 'poll', 'test'] as const;
export type RawOrigin = (typeof RAW_ORIGINS)[number];

export const MATCH_SKIPS = ['process_disabled', 'trigger_disabled', 'type_not_subscribed'] as const;
export type MatchSkip = (typeof MATCH_SKIPS)[number];

export const PROCESS_MATCH_OUTCOMES = ['matched', 'filter_error', 'filtered'] as const;
export type ProcessMatchOutcome = (typeof PROCESS_MATCH_OUTCOMES)[number];

export const DISPATCH_OUTCOMES = ['batched', 'deduped', 'filter_error'] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

export const BATCH_KINDS = ['event', 'sweep', 'manual'] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

/** How a run's input is mapped: a manual run maps as an event run or a sweep. */
export type MappingMode = Exclude<BatchKind, 'manual'>;

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

/** A gate stopped the batch (or a person rejected it). */
export const HELD_BATCH_OUTCOMES = [
  'held',
  'awaiting_approval',
  'rejected',
] as const satisfies readonly BatchOutcome[];

/** Waiting for the next sweep: held, throttled or awaiting approval. */
export const STOPPED_BATCH_OUTCOMES = [
  'held',
  'throttled',
  'awaiting_approval',
] as const satisfies readonly BatchOutcome[];

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

export const TERMINAL_RUN_STATUSES = [
  'ok',
  'error',
  'failed',
  'unknown',
  'held',
] as const satisfies readonly RunStatusValue[];
export const OPEN_RUN_STATUSES = [
  'invoking',
  'running',
  'uncertain',
] as const satisfies readonly RunStatusValue[];

export const BREAKER_RUN_STATUSES = [
  'error',
  'unknown',
] as const satisfies readonly RunStatusValue[];

/** The backend reported failure (`error`) or refused the invoke (`failed`). */
export const FAILED_RUN_STATUSES = ['error', 'failed'] as const satisfies readonly RunStatusValue[];

/** What a destination's tracking reports; each is also a run status. */
export const TRACKING_STATES = RUN_STATES satisfies readonly RunStatusValue[];
export type TrackingState = (typeof TRACKING_STATES)[number];

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
  return isOneOf(SETTLED_RUN_STATUSES, s);
}

export function isTerminalRunStatus(s: RunStatusValue): boolean {
  return isOneOf(TERMINAL_RUN_STATUSES, s);
}

export function isOpenRunStatus(s: RunStatusValue): boolean {
  return isOneOf(OPEN_RUN_STATUSES, s);
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

export const RUN_CAP_LIMITS = [
  'runs_per_hour',
  'runs_per_day',
  'destination_runs_per_hour',
  'destination_runs_per_day',
] as const;
export type RunCapLimit = (typeof RUN_CAP_LIMITS)[number];

export const USAGE_CAP_SCOPES = ['usage_per_day', 'destination_usage_per_day'] as const;
export type UsageCapScope = (typeof USAGE_CAP_SCOPES)[number];

export type BindingLimit =
  RunCapLimit | `${UsageCapScope}:${string}` | `meter:${string}` | 'soft_hold';

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
export const APPROVAL_DECISIONS = ['approved', 'rejected', 'withdrawn'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

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

export const INSTANCE_KINDS = PLUGIN_KINDS;
export type InstanceKind = (typeof INSTANCE_KINDS)[number];

/** Why an instance has no live object (or, for `disabled`, why it is not taking work). */
export const INSTANCE_ERROR_CODES = [
  'plugin_unavailable',
  'disabled',
  'secret_error',
  'create_failed',
] as const;
export type InstanceErrorCode = (typeof INSTANCE_ERROR_CODES)[number];

/** Counted against the plugin on its `plugins` row. */
export const PLUGIN_ERROR_KINDS = ['exception', 'invalid_event', 'invalid_usage'] as const;
export type PluginErrorKind = (typeof PLUGIN_ERROR_KINDS)[number];

/** `audit_log.scope`. */
export const AUDIT_SCOPES = [
  'process',
  'source',
  'destination',
  'notifier',
  'secret_provider',
  'plugin',
  'approval',
  'run',
  'event',
  'user',
  'token',
  'settings',
] as const;
export type AuditScope = (typeof AUDIT_SCOPES)[number];

export const STATS_WINDOWS = ['24h', '7d', '30d'] as const;
export type StatsWindow = (typeof STATS_WINDOWS)[number];

/** `plugins.status`. */
export const PLUGIN_STATUSES = ['loaded', 'unavailable', 'failed', 'incompatible'] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/** `baked` (image node_modules) or `installed` ($SWITCHBOARD_HOME/plugins). */
export const PLUGIN_ORIGINS = ['baked', 'installed'] as const;
export type PluginOrigin = (typeof PLUGIN_ORIGINS)[number];

/** Worst first: the order attention lists and explanations sort by. */
export const STATUS_TONES = ['error', 'warn', 'ok', 'off'] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

export function toneRank(tone: StatusTone): number {
  return STATUS_TONES.indexOf(tone);
}

/** An explanation of what happened to an event never reads as an error. */
export type ExplanationTone = Exclude<StatusTone, 'error'>;

export const ATTENTION_KINDS = [
  'breaker',
  'unhealthy',
  'meter_stale',
  'source_silent',
  'approval',
  'plugin_unavailable',
  'uncertain_runs',
  'process_disabled',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** The one-click action an attention item offers. */
export const ATTENTION_ACTIONS = [
  'reset_breaker',
  'approve',
  'open_approvals',
  'reload',
  'open',
  'test_event',
  'read_meters',
  'enable_process',
] as const;
export type AttentionAction = (typeof ATTENTION_ACTIONS)[number];
