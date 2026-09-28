import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  json,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { ArtifactRef, Attributes, Health, UsageReport } from '@ai-switchboard/sdk';

import type { ProcessDocument } from '../domain/process.js';
import type {
  ApprovalDecision,
  BatchKind,
  BatchOutcome,
  DispatchOutcome,
  EventStage,
  Role,
  RunStatusValue,
  StepPhase,
  StepStatus,
} from '../domain/status.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const id = () => uuid('id').primaryKey().defaultRandom();

export type PluginKindColumn = 'source' | 'executor' | 'notifier' | 'secret_provider';

/** Core-added per-instance caps for sources. */
export interface SourceCaps {
  eventCapPerHour?: number;
  eventCapPerDay?: number;
  eventTypesEnabled?: string[];
  pollIntervalSeconds?: number;
  /** Only for `webhook` instances explicitly marked unauthenticated (evaluation). */
  unauthenticated?: boolean;
}

/** Core-added per-instance caps for executors. */
export interface ExecutorCaps {
  runsPerHour?: number;
  runsPerDay?: number;
  usagePerDay?: Record<string, number>;
  meterPollSeconds?: number;
  meterStalenessMinutes?: number;
  /** Typed-in limits for estimated meters, keyed by meter id. */
  estimatedLimits?: Record<string, number>;
  /**
   * How long to wait for `invoke` to answer (1–3600 s); overrides the executor type's
   * per-target and default timeouts.
   */
  invokeTimeoutSeconds?: number;
}

// ------------------------------------------------------------------------------------------
// Plugins
// ------------------------------------------------------------------------------------------

export const plugins = pgTable('plugins', {
  name: text('name').primaryKey(),
  pluginId: text('plugin_id').notNull(),
  displayName: text('display_name').notNull(),
  version: text('version').notNull(),
  integrity: text('integrity'),
  sdkRange: text('sdk_range').notNull(),
  capabilities: jsonb('capabilities')
    .$type<{ network?: string[]; secrets?: string[] }>()
    .notNull()
    .default({}),
  /** `loaded` | `unavailable` | `failed` | `incompatible` */
  status: text('status').notNull(),
  statusMessage: text('status_message'),
  /** `baked` (image node_modules) or `installed` ($SWITCHBOARD_HOME/plugins). */
  origin: text('origin').notNull().default('baked'),
  /**
   * Set when an admin installed the plugin through the API: the npm spec and exact version every
   * replica converges on (installing it into its own $SWITCHBOARD_HOME). Null for baked plugins
   * and for plugins added with the CLI.
   */
  installSpec: text('install_spec'),
  installVersion: text('install_version'),
  installedAt: ts('installed_at'),
  /**
   * Tombstone set by `DELETE /plugins/:name`: every replica's sync pass removes the package from
   * its own $SWITCHBOARD_HOME (when installed there before this time) and unregisters it. An API
   * re-install clears it.
   */
  removeRequestedAt: ts('remove_requested_at'),
  errorCount: integer('error_count').notNull().default(0),
  invalidEventCount: integer('invalid_event_count').notNull().default(0),
  loadedAt: ts('loaded_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const pluginTypes = pgTable(
  'plugin_types',
  {
    plugin: text('plugin').notNull(),
    kind: text('kind').$type<PluginKindColumn>().notNull(),
    typeId: text('type_id').notNull(),
    displayName: text('display_name').notNull(),
    /**
     * Serializable manifest: schemas, event types, actions, usage, meters, tracking. `json`, not
     * `jsonb`: jsonb reorders object keys, and a settings form must keep the declared field order.
     */
    manifest: json('manifest').$type<Record<string, unknown>>().notNull(),
    available: boolean('available').notNull().default(true),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.typeId] })],
);

// ------------------------------------------------------------------------------------------
// Instances
// ------------------------------------------------------------------------------------------

export const sources = pgTable('sources', {
  id: id(),
  typeId: text('type_id').notNull(),
  name: text('name').notNull(),
  /** Plugin settings; secret fields hold `secret://` references, never values. */
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean('enabled').notNull().default(true),
  caps: jsonb('caps').$type<SourceCaps>().notNull().default({}),
  watermark: text('watermark'),
  health: jsonb('health').$type<Health>(),
  lastEventAt: ts('last_event_at'),
  lastVerifyFailureAt: ts('last_verify_failure_at'),
  /** Pull sources: when the poller last claimed this instance. */
  lastPolledAt: ts('last_polled_at'),
  /** When the silence alert was last sent for this instance (cleared by the next event). */
  silenceAlertedAt: ts('silence_alerted_at'),
  secretsResolvedAt: ts('secrets_resolved_at'),
  provisionedAt: ts('provisioned_at'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const executors = pgTable('executors', {
  id: id(),
  typeId: text('type_id').notNull(),
  name: text('name').notNull(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  targetDefaults: jsonb('target_defaults').$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean('enabled').notNull().default(true),
  caps: jsonb('caps').$type<ExecutorCaps>().notNull().default({}),
  softHoldUntil: ts('soft_hold_until'),
  softHoldReason: text('soft_hold_reason'),
  health: jsonb('health').$type<Health>(),
  secretsResolvedAt: ts('secrets_resolved_at'),
  metersReadAt: ts('meters_read_at'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const meterReadings = pgTable(
  'meter_readings',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    executorId: uuid('executor_id').notNull(),
    meterId: text('meter_id').notNull(),
    observedAt: ts('observed_at').notNull(),
    used: doublePrecision('used'),
    limit: doublePrecision('limit'),
    utilization: doublePrecision('utilization').notNull(),
    resetsAt: ts('resets_at'),
    estimated: boolean('estimated').notNull().default(false),
  },
  (t) => [index('meter_readings_latest').on(t.executorId, t.meterId, t.observedAt.desc())],
);

export const notifiers = pgTable('notifiers', {
  id: id(),
  typeId: text('type_id').notNull(),
  name: text('name').notNull(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean('enabled').notNull().default(true),
  health: jsonb('health').$type<Health>(),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const secretProviders = pgTable(
  'secret_providers',
  {
    id: id(),
    typeId: text('type_id').notNull(),
    /** The `<provider>` segment of `secret://<provider>/<name>`. */
    name: text('name').notNull(),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    health: jsonb('health').$type<Health>(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('secret_providers_name').on(t.name)],
);

/** Plugin `InstanceState` key/values (e.g. a rotated OAuth refresh token). */
export const instanceState = pgTable(
  'instance_state',
  {
    instanceId: uuid('instance_id').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.instanceId, t.key] })],
);

// ------------------------------------------------------------------------------------------
// Processes
// ------------------------------------------------------------------------------------------

export const processes = pgTable('processes', {
  id: id(),
  name: text('name').notNull(),
  document: jsonb('document').$type<ProcessDocument>().notNull(),
  enabled: boolean('enabled').notNull().default(false),
  /** `closed` | `open` */
  breakerState: text('breaker_state').$type<'closed' | 'open'>().notNull().default('closed'),
  breakerOpenedAt: ts('breaker_opened_at'),
  /** Runs finished before this are ignored by the breaker (set on reset by hand or cooldown). */
  breakerResetAt: ts('breaker_reset_at'),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const processVersions = pgTable(
  'process_versions',
  {
    processId: uuid('process_id').notNull(),
    version: integer('version').notNull(),
    document: jsonb('document').$type<ProcessDocument>().notNull(),
    savedBy: text('saved_by').notNull(),
    savedAt: ts('saved_at').notNull().defaultNow(),
    reason: text('reason').notNull(),
  },
  (t) => [primaryKey({ columns: [t.processId, t.version] })],
);

/** One row per fired schedule tick; the unique key makes each tick fire once across replicas. */
export const scheduleTicks = pgTable(
  'schedule_ticks',
  {
    processId: uuid('process_id').notNull(),
    scheduleId: text('schedule_id').notNull(),
    tickAt: ts('tick_at').notNull(),
    firedAt: ts('fired_at').notNull().defaultNow(),
    batchId: uuid('batch_id'),
    catchUp: boolean('catch_up').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.processId, t.scheduleId, t.tickAt] })],
);

// ------------------------------------------------------------------------------------------
// Pipeline records
// ------------------------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    sourceId: uuid('source_id').notNull(),
    sourceType: text('source_type').notNull(),
    type: text('type').notNull(),
    occurredAt: ts('occurred_at').notNull(),
    receivedAt: ts('received_at').notNull(),
    artifact: jsonb('artifact').$type<ArtifactRef>().notNull(),
    /** `artifact.kind:artifact.id`, indexed for the trace search. */
    artifactKey: text('artifact_key').notNull(),
    attributes: jsonb('attributes').$type<Attributes>().notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    deliveryId: text('delivery_id'),
    rawRef: text('raw_ref').notNull(),
    stage: text('stage').$type<EventStage>().notNull(),
    stageReason: text('stage_reason'),
    replayOf: uuid('replay_of'),
    /** Every trigger filter evaluated for this event (true, false or error), for the trace. */
    matchDecisions: jsonb('match_decisions').$type<MatchDecisionRecord[]>().notNull().default([]),
  },
  (t) => [
    index('events_received').on(t.receivedAt.desc()),
    index('events_source_received').on(t.sourceId, t.receivedAt.desc()),
    index('events_artifact').on(t.artifactKey),
    index('events_artifact_id').on(sql`(${t.artifact}->>'id')`),
    index('events_pending_match')
      .on(t.receivedAt)
      .where(sql`${t.stage} = 'received'`),
    uniqueIndex('events_delivery')
      .on(t.sourceId, t.deliveryId, t.type, t.artifactKey)
      .where(sql`${t.deliveryId} IS NOT NULL AND ${t.replayOf} IS NULL`),
  ],
);

export const eventRaw = pgTable(
  'event_raw',
  {
    ref: text('ref').primaryKey(),
    sourceId: uuid('source_id').notNull(),
    body: bytea('body').notNull(),
    headers: jsonb('headers').$type<Record<string, string | undefined>>().notNull(),
    receivedAt: ts('received_at').notNull(),
    /** `ok` | `rejected:<reason>` | `unverified:source_disabled` (body not kept) */
    verify: text('verify').notNull().default('ok'),
  },
  (t) => [index('event_raw_received').on(t.receivedAt)],
);

export const batches = pgTable(
  'batches',
  {
    id: id(),
    processId: uuid('process_id').notNull(),
    batchKey: text('batch_key').notNull().default(''),
    kind: text('kind').$type<BatchKind>().notNull(),
    openedAt: ts('opened_at').notNull(),
    fireAfter: ts('fire_after').notNull(),
    closedAt: ts('closed_at'),
    size: integer('size').notNull().default(0),
    outcome: text('outcome').$type<BatchOutcome>().notNull().default('open'),
    outcomeReason: text('outcome_reason'),
    approvalState: text('approval_state')
      .$type<'none' | 'pending' | 'approved' | 'rejected'>()
      .notNull()
      .default('none'),
    /** For sweeps: the schedule that fired it. */
    scheduleId: text('schedule_id'),
    /** When a sweep merged an open event batch into its run. */
    mergedInto: uuid('merged_into'),
    /** Manual runs: requested dry run. */
    dryRun: boolean('dry_run').notNull().default(false),
    requestedBy: text('requested_by'),
    /** Manual test runs: the batch whose events this run replays. */
    eventsFrom: uuid('events_from'),
    /** Sweeps: the cron tick that fired it (for `switchboard.schedule.lag`). */
    tickAt: ts('tick_at'),
    /** Gate and budget checks at decision time, for the trace. */
    decisions: jsonb('decisions').$type<GateDecisionRecord[]>().notNull().default([]),
  },
  (t) => [
    uniqueIndex('batches_one_open')
      .on(t.processId, t.batchKey)
      .where(sql`${t.outcome} = 'open' AND ${t.kind} = 'event'`),
    index('batches_process').on(t.processId, t.openedAt.desc()),
    index('batches_fire')
      .on(t.fireAfter)
      .where(sql`${t.outcome} = 'open'`),
  ],
);

/** One trigger filter evaluation, stored on the event for the trace ("why did nothing happen"). */
export interface MatchDecisionRecord {
  processId: string;
  triggerId: string;
  expr?: string;
  result: boolean;
  error?: string;
  /** The batch key the group-by expression produced (when it matched). */
  batchKey?: string;
  at: string;
}

export interface GateDecisionRecord {
  /** `batch` records open/close, `approval` the decision, `gate`/`budget` the checks. */
  stage: 'gate' | 'budget' | 'batch' | 'approval';
  check: string;
  pass: boolean;
  detail?: string;
  at: string;
  /** Budget stage: counters and meter readings at that moment. */
  data?: Record<string, unknown>;
}

export const dispatches = pgTable(
  'dispatches',
  {
    id: id(),
    eventId: uuid('event_id').notNull(),
    processId: uuid('process_id').notNull(),
    triggerId: text('trigger_id').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    outcome: text('outcome').$type<DispatchOutcome>().notNull(),
    /** Filter evaluation record for the trace: the expression and its result. */
    filter: jsonb('filter').$type<{ expr?: string; result: boolean; error?: string }>(),
    batchId: uuid('batch_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('dispatches_dedupe').on(t.processId, t.dedupeKey, t.createdAt.desc()),
    index('dispatches_event').on(t.eventId),
    index('dispatches_batch').on(t.batchId),
    index('dispatches_process_created').on(t.processId, t.createdAt.desc()),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: id(),
    batchId: uuid('batch_id').notNull(),
    processId: uuid('process_id').notNull(),
    processVersion: integer('process_version').notNull(),
    executorId: uuid('executor_id').notNull(),
    kind: text('kind').$type<BatchKind>().notNull(),
    status: text('status').$type<RunStatusValue>().notNull(),
    statusReason: text('status_reason'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    input: jsonb('input'),
    result: jsonb('result'),
    usage: jsonb('usage').$type<UsageReport>(),
    errors: jsonb('errors').$type<string[]>(),
    dryRun: boolean('dry_run').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    invokedAt: ts('invoked_at'),
    finishedAt: ts('finished_at'),
    deadlineAt: ts('deadline_at'),
    nextPollAt: ts('next_poll_at'),
    pollCount: integer('poll_count').notNull().default(0),
    /** Set while an invoke attempt is in flight; cleared while a retry waits. */
    invokeStartedAt: ts('invoke_started_at'),
    /**
     * When the in-flight attempt is past its time (its steps' budget, the effective invoke
     * timeout and a margin): before this, recovery leaves the attempt alone.
     */
    invokeDeadlineAt: ts('invoke_deadline_at'),
    /** Earliest event occurredAt in the batch, for latency. */
    firstEventAt: ts('first_event_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('runs_batch').on(t.batchId),
    index('runs_process_invoked').on(t.processId, t.invokedAt.desc()),
    index('runs_executor_invoked').on(t.executorId, t.invokedAt.desc()),
    index('runs_open')
      .on(t.status)
      .where(sql`${t.status} IN ('invoking','running','uncertain')`),
    index('runs_external').on(t.executorId, t.externalId),
  ],
);

export const steps = pgTable(
  'steps',
  {
    id: id(),
    runId: uuid('run_id').notNull(),
    phase: text('phase').$type<StepPhase>().notNull(),
    index: integer('index').notNull(),
    providerId: text('provider_id').notNull(),
    action: text('action').notNull(),
    args: jsonb('args'),
    status: text('status').$type<StepStatus>().notNull(),
    error: text('error'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [
    index('steps_run').on(t.runId),
    // The step journal: one row per step, written `started` before the action runs.
    uniqueIndex('steps_run_phase_index').on(t.runId, t.phase, t.index),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    batchId: uuid('batch_id').primaryKey(),
    processId: uuid('process_id').notNull(),
    rule: text('rule').notNull(),
    input: jsonb('input'),
    requestedAt: ts('requested_at').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: ts('decided_at'),
    decision: text('decision').$type<ApprovalDecision>(),
    reason: text('reason'),
  },
  (t) => [
    index('approvals_pending')
      .on(t.requestedAt)
      .where(sql`${t.decision} IS NULL`),
  ],
);

/** Tracking updates (poll results, callbacks) for the trace timeline. */
export const runUpdates = pgTable(
  'run_updates',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid('run_id').notNull(),
    at: ts('at').notNull(),
    source: text('source')
      .$type<'invoke' | 'poll' | 'callback' | 'deadline' | 'manual' | 'recovery'>()
      .notNull(),
    status: text('status').$type<RunStatusValue>().notNull(),
    detail: jsonb('detail'),
  },
  (t) => [index('run_updates_run').on(t.runId, t.at)],
);

// ------------------------------------------------------------------------------------------
// Users, auth, audit, settings, stats
// ------------------------------------------------------------------------------------------

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  role: text('role').$type<Role>().notNull(),
  oidcSubject: text('oidc_subject'),
  /** scrypt hash (`auth/crypto.ts`) for a local password; null for an OIDC-only account. */
  passwordHash: text('password_hash'),
  /** Set when an admin (or bootstrap) chose the password; the next password sign-in must change it. */
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  lastLoginAt: ts('last_login_at'),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 of the cookie token. */
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id').notNull(),
    expiresAt: ts('expires_at').notNull(),
    /** How the session signed in; a `password` session is restricted while the user must change it. */
    method: text('method').$type<'password' | 'oidc'>().notNull().default('password'),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

/**
 * Failed sign-in (and password confirmation) attempts, one row per failure and throttle key, so
 * every replica counts the same window (`auth/throttle.ts`). Pruned by the `auth.prune` job.
 */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** `ip:<address>`, `email:<sha256 of the normalised email>` or `password:<user id>`. */
    key: text('key').notNull(),
    at: ts('at').notNull(),
  },
  (t) => [index('login_attempts_key_at').on(t.key, t.at)],
);

export const apiTokens = pgTable('api_tokens', {
  id: id(),
  userId: uuid('user_id').notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  role: text('role').$type<Role>().notNull(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    actor: text('actor').notNull(),
    at: ts('at').notNull().defaultNow(),
    /** `process` | `source` | `executor` | `plugin` | `user` | `settings` | `approval` | `run` | ... */
    scope: text('scope').notNull(),
    targetId: text('target_id'),
    field: text('field'),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
  },
  (t) => [index('audit_at').on(t.at.desc()), index('audit_target').on(t.scope, t.targetId)],
);

/** Global settings as one row per key. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const statsHourly = pgTable(
  'stats_hourly',
  {
    /** `source` | `event_type` | `process` | `executor` | `meter` | `plugin` */
    dimension: text('dimension').notNull(),
    key: text('key').notNull(),
    hour: ts('hour').notNull(),
    counters: jsonb('counters').$type<Record<string, number>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.dimension, t.key, t.hour] })],
);

/** Every notification the pipeline sent (or failed to send), for the trace. */
export const notificationLog = pgTable(
  'notification_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    notifierId: text('notifier_id').notNull(),
    /** `ok` | `error` | `held` | `throttled` | `system` */
    on: text('on').notNull(),
    processId: uuid('process_id'),
    batchId: uuid('batch_id'),
    runId: uuid('run_id'),
    title: text('title').notNull(),
    text: text('text').notNull(),
    /** `sending`: claimed before the send (a crash leaves it; it is never sent twice). */
    status: text('status').$type<'sending' | 'sent' | 'error'>().notNull(),
    error: text('error'),
    at: ts('at').notNull(),
  },
  (t) => [
    // A run's notification is claimed once per notifier and outcome before it is sent.
    uniqueIndex('notification_log_run_notifier_on')
      .on(t.runId, t.notifierId, t.on)
      .where(sql`${t.runId} IS NOT NULL`),
    index('notification_log_batch').on(t.batchId),
    index('notification_log_run').on(t.runId),
    index('notification_log_at').on(t.at),
  ],
);

/** Rate-limit state for system alerts, keyed by what the alert is about. */
export const systemAlerts = pgTable('system_alerts', {
  key: text('key').primaryKey(),
  lastSentAt: ts('last_sent_at').notNull(),
  count: integer('count').notNull().default(1),
});

/** Live replicas (heartbeat), for Settings › About. */
export const replicas = pgTable('replicas', {
  id: text('id').primaryKey(),
  hostname: text('hostname').notNull(),
  version: text('version').notNull(),
  startedAt: ts('started_at').notNull(),
  heartbeatAt: ts('heartbeat_at').notNull(),
});
