import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
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
    /** Serializable manifest: schemas, event types, actions, usage, meters, tracking. */
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
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
  },
  (t) => [
    index('events_received').on(t.receivedAt.desc()),
    index('events_source_received').on(t.sourceId, t.receivedAt.desc()),
    index('events_artifact').on(t.artifactKey),
    index('events_artifact_id').on(sql`(${t.artifact}->>'id')`),
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
    /** `ok` | `rejected:<reason>` */
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

export interface GateDecisionRecord {
  stage: 'gate' | 'budget';
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
    bindingLimit: text('binding_limit'),
    dryRun: boolean('dry_run').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    invokedAt: ts('invoked_at'),
    finishedAt: ts('finished_at'),
    deadlineAt: ts('deadline_at'),
    nextPollAt: ts('next_poll_at'),
    pollCount: integer('poll_count').notNull().default(0),
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
  (t) => [index('steps_run').on(t.runId)],
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
  /** scrypt hash for the bootstrap local admin only. */
  passwordHash: text('password_hash'),
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
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [index('sessions_user').on(t.userId)],
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

/** Live replicas (heartbeat), for Settings › About. */
export const replicas = pgTable('replicas', {
  id: text('id').primaryKey(),
  hostname: text('hostname').notNull(),
  version: text('version').notNull(),
  startedAt: ts('started_at').notNull(),
  heartbeatAt: ts('heartbeat_at').notNull(),
});
