/**
 * The REST API contract between the core and the web UI (and the CLI). Types only.
 *
 * Every route lives under `/api/v1`. Every state-changing request body carries `reason` (a
 * one-line human reason, audited). Errors are `ApiError`. Lists that can grow are paginated with
 * an opaque `cursor` and return `Page<T>`.
 */
import type {
  ActionSpec,
  ArtifactRef,
  Attributes,
  Capabilities,
  EventTypeSpec,
  Health,
  JSONSchema,
  MeterSpec,
  TrackingMode,
  UsageDimension,
  UsageReport,
} from '@ai-switchboard/sdk';

import type { ProcessDocument } from '../domain/process.js';
import type {
  BatchKind,
  BatchOutcome,
  EventStage,
  Role,
  RunStatusValue,
  StatusTone,
  StepStatus,
} from '../domain/status.js';

export type { ProcessDocument } from '../domain/process.js';
export type {
  Trigger,
  Schedule,
  Step,
  Notification,
  QuietWindow,
  MeterCeiling,
} from '../domain/process.js';
export type {
  BatchKind,
  BatchOutcome,
  EventStage,
  Role,
  RunStatusValue,
  StatusTone,
  StepStatus,
} from '../domain/status.js';
export type {
  ArtifactRef,
  Attributes,
  EventTypeSpec,
  Health,
  JSONSchema,
  MeterSpec,
  UsageDimension,
  UsageReport,
  ActionSpec,
  Capabilities,
  TrackingMode,
};

export type Iso = string;

export interface ApiError {
  error: string;
  message: string;
  /** Field-level problems, e.g. schema validation messages. */
  details?: string[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Every mutation carries a reason; the API rejects an empty one with 400. */
export interface Reasoned {
  reason: string;
}

/** A status word plus its tone in the four-colour vocabulary. Always shown with its label. */
export interface StatusLabel {
  tone: StatusTone;
  label: string;
}

// ---------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------

export interface UserDTO {
  id: string;
  email: string;
  role: Role;
  /** The account can sign in with a local password. */
  hasPassword: boolean;
  /** The account is linked to an OIDC identity (it has signed in through the issuer). */
  hasOidc: boolean;
  /** The password was set by an admin (or bootstrap); the next password sign-in must change it. */
  mustChangePassword: boolean;
  lastLoginAt: Iso | null;
  createdAt: Iso;
}

/**
 * GET /users/directory: who can sign in and with which role, for every signed-in role. Email and
 * role only; sign-in methods and times stay admin-only (`UserDTO`).
 */
export interface UserDirectoryEntry {
  id: string;
  email: string;
  role: Role;
}

export interface MeResponse {
  user: UserDTO | null;
  /**
   * `oidc` when an OIDC issuer is configured. Local password sign-in is available in both modes;
   * `oidc` only adds the "Sign in with <issuer>" button.
   */
  authMode: 'oidc' | 'local';
  oidcConfigured: boolean;
  /** The issuer's host, for the sign-in button label; null without OIDC. */
  oidcIssuer: string | null;
  evaluation: boolean;
  /**
   * This session signed in with a temporary password: every route except `GET /auth/me`,
   * `POST /auth/password` and `POST /auth/logout` answers 403 `password_change_required`.
   */
  mustChangePassword: boolean;
  /**
   * Evaluation mode only: the bootstrap local admin's email (`admin@switchboard.local` unless
   * `SWITCHBOARD_BOOTSTRAP_ADMIN` names another), for the sign-in page's recovery hint. Null
   * outside evaluation mode or when that account has no password; no other email is ever shown.
   */
  evaluationAdminEmail: string | null;
}

export interface LocalLoginRequest {
  email: string;
  password: string;
}

/** POST /auth/password: the signed-in user changes their own password. */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** PUT /users/:id/password: an admin sets or resets a user's password (a temporary password). */
export interface SetPasswordRequest extends Reasoned {
  password: string;
}

// ---------------------------------------------------------------------------------------------
// Status strip (top bar) and board
// ---------------------------------------------------------------------------------------------

export interface MeterGaugeDTO {
  executorId: string;
  executorName: string;
  meterId: string;
  title: string;
  kind: MeterSpec['kind'];
  unit: string;
  utilization: number | null;
  used: number | null;
  limit: number | null;
  resetsAt: Iso | null;
  observedAt: Iso | null;
  estimated: boolean;
  stale: boolean;
  /** Process ceilings bound to this meter, for marks on the gauge. */
  ceilings: { processId: string; processName: string; events: number; sweeps: number }[];
  primary: boolean;
}

export interface StatusStripResponse {
  meters: MeterGaugeDTO[];
  openBreakers: number;
  pendingApprovals: number;
  evaluation: boolean;
  oidcConfigured: boolean;
}

/** Five pipeline stops shown as dots: matched → batched → gated → invoked → ok. */
export interface PipelineDots {
  matched: number;
  batched: number;
  gated: number;
  invoked: number;
  ok: number;
  /** Tone per stop, derived from the last hour. */
  tones: [StatusTone, StatusTone, StatusTone, StatusTone, StatusTone];
}

export interface BoardSourceNode {
  id: string;
  name: string;
  typeId: string;
  typeName: string;
  /** The type's declared icon (see `SourceSummary.typeIcon`). */
  typeIcon: string | null;
  status: StatusLabel;
  enabled: boolean;
  lastEventAt: Iso | null;
  events24h: number;
  pluginAvailable: boolean;
  unauthenticated: boolean;
}

export interface BoardProcessNode {
  id: string;
  name: string;
  status: StatusLabel;
  enabled: boolean;
  breakerOpen: boolean;
  awaitingApproval: number;
  dots: PipelineDots;
  nextSweepAt: Iso | null;
  runs24h: number;
  lastRunAt: Iso | null;
}

export interface BoardExecutorNode {
  id: string;
  name: string;
  typeId: string;
  typeName: string;
  /** The type's declared icon (see `SourceSummary.typeIcon`). */
  typeIcon: string | null;
  status: StatusLabel;
  enabled: boolean;
  meters: MeterGaugeDTO[];
  softHoldUntil: Iso | null;
}

export interface BoardEdge {
  id: string;
  kind: 'trigger' | 'binding';
  from: string;
  to: string;
  /** Trigger edges: the event types. */
  eventTypes: string[];
  label: string;
  volume24h: number;
  /** Events (trigger) or runs (binding) in the last 5 minutes, for animated dots. */
  recent: number;
  enabled: boolean;
}

export interface AttentionItem {
  id: string;
  kind:
    | 'breaker'
    | 'unhealthy'
    | 'meter_stale'
    | 'source_silent'
    | 'approval'
    | 'plugin_unavailable'
    | 'uncertain_runs';
  tone: StatusTone;
  title: string;
  detail: string;
  targetKind: 'process' | 'source' | 'executor' | 'plugin' | 'approval';
  targetId: string;
  /** The one-click action, e.g. `reset_breaker`, `approve`, `reload`, `read_meters`, `open`. */
  action: { id: string; label: string };
  since: Iso | null;
}

export interface BoardResponse {
  sources: BoardSourceNode[];
  processes: BoardProcessNode[];
  executors: BoardExecutorNode[];
  edges: BoardEdge[];
  attention: AttentionItem[];
  generatedAt: Iso;
}

// ---------------------------------------------------------------------------------------------
// Plugin types (for creating instances)
// ---------------------------------------------------------------------------------------------

export type PluginKind = 'source' | 'executor' | 'notifier' | 'secret_provider';

export interface PluginTypeDTO {
  kind: PluginKind;
  typeId: string;
  displayName: string;
  description?: string;
  /**
   * The icon the plugin declared (SDK 1.3): a built-in icon name (`ICON_NAMES`) or a
   * `data:image/svg+xml;base64,…` URI (render through `<img>` only). Absent: the kind's icon.
   */
  icon?: string;
  plugin: string;
  available: boolean;
  settingsSchema: JSONSchema;
  // sources
  mode?: 'push' | 'pull' | 'both';
  eventTypes?: EventTypeSpec[];
  dynamicEventTypes?: boolean;
  provisionSupported?: boolean;
  allowsUnauthenticated?: boolean;
  // executors
  targetSchema?: JSONSchema;
  inputSchema?: JSONSchema;
  tracking?: TrackingMode;
  idempotentInvoke?: boolean;
  usage?: UsageDimension[];
  meters?: MeterSpec[];
  examples?: { target: unknown; input: unknown }[];
  actions?: ActionSpec[];
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

export interface SourceCapsDTO {
  eventCapPerHour?: number;
  eventCapPerDay?: number;
  eventTypesEnabled?: string[];
  pollIntervalSeconds?: number;
  unauthenticated?: boolean;
}

export interface SecretRefDTO {
  field: string;
  ref: string;
  lastResolvedAt: Iso | null;
  ok: boolean;
  error?: string;
}

export interface SourceSummary {
  id: string;
  name: string;
  typeId: string;
  typeName: string;
  /**
   * The type's declared icon: a built-in icon name or an SVG data URI (see
   * `PluginTypeDTO.icon`); `null` when the type declares none or its plugin is not loaded.
   */
  typeIcon: string | null;
  mode: 'push' | 'pull' | 'both';
  enabled: boolean;
  status: StatusLabel;
  health: Health | null;
  lastEventAt: Iso | null;
  eventsByType24h: { type: string; count: number }[];
  pluginAvailable: boolean;
  unauthenticated: boolean;
  processCount: number;
}

export interface SourceDetail extends SourceSummary {
  settings: Record<string, unknown>;
  caps: SourceCapsDTO;
  webhookUrl: string | null;
  pollIntervalSeconds: number | null;
  provisionSupported: boolean;
  provisionedAt: Iso | null;
  secretRefs: SecretRefDTO[];
  eventTypes: EventTypeSpec[];
  actions: ActionSpec[];
  settingsSchema: JSONSchema;
  lastVerifyFailureAt: Iso | null;
  instanceError: string | null;
  processes: { id: string; name: string; eventTypes: string[] }[];
  createdAt: Iso;
  updatedAt: Iso;
}

export interface CreateSourceRequest extends Reasoned {
  typeId: string;
  name: string;
  settings: Record<string, unknown>;
  caps?: SourceCapsDTO;
  enabled?: boolean;
}

export interface UpdateSourceRequest extends Reasoned {
  name?: string;
  settings?: Record<string, unknown>;
  caps?: SourceCapsDTO;
}

export interface EnableRequest extends Reasoned {
  enabled: boolean;
}

export interface SourceStatsResponse {
  window: StatsWindow;
  /** Hourly buckets. */
  buckets: {
    hour: Iso;
    byType: Record<string, number>;
    byStage: Partial<Record<EventStage, number>>;
  }[];
  verifyFailures: { hour: Iso; count: number }[];
}

// ---------------------------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------------------------

export interface ExecutorCapsDTO {
  runsPerHour?: number;
  runsPerDay?: number;
  usagePerDay?: Record<string, number>;
  meterPollSeconds?: number;
  meterStalenessMinutes?: number;
  estimatedLimits?: Record<string, number>;
  /**
   * How long to wait for `invoke` to answer, 1–3600 s. Overrides the type's per-target and
   * default timeouts (core default 300 s). No answer in time is a lost response.
   */
  invokeTimeoutSeconds?: number;
}

export interface ExecutorSummary {
  id: string;
  name: string;
  typeId: string;
  typeName: string;
  /** The type's declared icon (see `SourceSummary.typeIcon`). */
  typeIcon: string | null;
  enabled: boolean;
  status: StatusLabel;
  health: Health | null;
  meters: MeterGaugeDTO[];
  softHoldUntil: Iso | null;
  softHoldReason: string | null;
  pluginAvailable: boolean;
  runs24h: number;
  processCount: number;
}

export interface ExecutorDetail extends ExecutorSummary {
  settings: Record<string, unknown>;
  targetDefaults: Record<string, unknown>;
  caps: ExecutorCapsDTO;
  settingsSchema: JSONSchema;
  targetSchema: JSONSchema;
  inputSchema: JSONSchema;
  tracking: TrackingMode;
  idempotentInvoke: boolean;
  usage: UsageDimension[];
  meterSpecs: MeterSpec[];
  actions: ActionSpec[];
  callbackUrl: string;
  secretRefs: SecretRefDTO[];
  instanceError: string | null;
  processes: { id: string; name: string }[];
  createdAt: Iso;
  updatedAt: Iso;
}

export interface CreateExecutorRequest extends Reasoned {
  typeId: string;
  name: string;
  settings: Record<string, unknown>;
  targetDefaults?: Record<string, unknown>;
  caps?: ExecutorCapsDTO;
  enabled?: boolean;
}

export interface UpdateExecutorRequest extends Reasoned {
  name?: string;
  settings?: Record<string, unknown>;
  targetDefaults?: Record<string, unknown>;
  caps?: ExecutorCapsDTO;
}

export interface MeterHistoryResponse {
  window: StatsWindow;
  meters: {
    id: string;
    title: string;
    estimated: boolean;
    readings: { t: Iso; utilization: number; resetsAt: Iso | null }[];
    ceilings: MeterGaugeDTO['ceilings'];
  }[];
  runs: { t: Iso; runId: string; processId: string; processName: string; status: RunStatusValue }[];
}

export interface UsageHistoryResponse {
  window: StatsWindow;
  dimensions: { id: string; title: string; unit: string; days: { day: Iso; value: number }[] }[];
  runsByStatus: { day: Iso; counts: Partial<Record<RunStatusValue, number>> }[];
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

export type StatsWindow = '24h' | '7d' | '30d';

export interface ProcessSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: StatusLabel;
  breakerState: 'open' | 'closed';
  awaitingApproval: number;
  dots: PipelineDots;
  /** Runs per day, last 7 days, oldest first. */
  sparkline: number[];
  nextSweepAt: Iso | null;
  dailyCap: { used: number; limit: number | null };
  lastRunAt: Iso | null;
  executor: { id: string; name: string } | null;
  triggers: { sourceId: string; sourceName: string; describe: string; eventTypes: string[] }[];
  updatedAt: Iso;
}

export interface ProcessDetail {
  id: string;
  name: string;
  document: ProcessDocument;
  enabled: boolean;
  status: StatusLabel;
  breakerState: 'open' | 'closed';
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

export interface UpdateProcessRequest extends Reasoned {
  document: ProcessDocument;
  /** Optimistic concurrency: 409 when the stored version differs. */
  expectedVersion: number;
}

export interface RunNowRequest extends Reasoned {
  dryRun?: boolean;
  /** Test run with the events of a recent batch. */
  batchId?: string;
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

export interface InputPreviewResponse {
  input: unknown;
  valid: boolean;
  errors: string[];
}

export interface CronPreviewRequest {
  cron: string;
  timezone: string;
}

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

// ---------------------------------------------------------------------------------------------
// Events, activity and trace
// ---------------------------------------------------------------------------------------------

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
  }[];
  replayOf: string | null;
}

export interface ActivityQuery {
  source?: string;
  process?: string;
  executor?: string;
  stage?: string;
  /** Exact event type, e.g. `github.pull_request.labeled`. */
  type?: string;
  artifact?: string;
  from?: Iso;
  to?: Iso;
  cursor?: string;
  limit?: number;
}

export interface EventDetail extends ActivityRow {
  attributes: Attributes;
  dedupeKey: string;
  deliveryId: string | null;
  stageReason: string | null;
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

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

export interface RunSummary {
  id: string;
  processId: string;
  processName: string;
  executorId: string;
  executorName: string;
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
  executor?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

export interface CloseRunRequest extends Reasoned {
  status: 'ok' | 'error' | 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

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
  decision: 'approved' | 'rejected';
  decidedBy: string;
  decidedAt: Iso;
  reason: string;
}

export interface ApprovalRulesResponse {
  processes: { id: string; name: string; rule: string }[];
}

// ---------------------------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------------------------

export interface PluginSummary {
  name: string;
  pluginId: string;
  displayName: string;
  version: string;
  status: 'loaded' | 'unavailable' | 'failed' | 'incompatible';
  statusLabel: StatusLabel;
  statusMessage: string | null;
  origin: 'baked' | 'installed';
  sdkRange: string;
  capabilities: Capabilities;
  types: { kind: PluginKind; typeId: string; displayName: string; instanceCount: number }[];
  errorCount: number;
  invalidEventCount: number;
  integrity: string | null;
  pendingRestart: boolean;
}

export interface InspectPluginRequest {
  package: string;
  range?: string;
}

export interface InspectPluginResponse {
  package: string;
  version: string;
  sdkRange: string;
  compatible: boolean;
  capabilities: Capabilities;
  types: { kind: PluginKind; typeId: string; displayName: string }[];
  integrity: string | null;
}

export interface InstallPluginRequest extends Reasoned {
  package: string;
  range?: string;
}

/**
 * The `{kind}` segment of the plugin naming convention (`ai-switchboard-{kind}-{name}`), used as
 * `GET /plugins/search?kind=`.
 */
export type PluginSearchKind = 'source' | 'executor' | 'notifier' | 'secrets';

/** One npm package that follows the naming convention. */
export interface PluginSearchResult {
  package: string;
  /** The instance kind its name promises. */
  kind: PluginKind;
  /** Latest version on the registry. */
  version: string;
  description: string;
  /** npm user who published the latest version. */
  publisher: string | null;
  /** When the latest version was published. */
  date: Iso | null;
  links: { npm?: string; homepage?: string; repository?: string };
  weeklyDownloads: number | null;
  /** Loaded, or installed and waiting for a restart. */
  installed: boolean;
  installedVersion: string | null;
  /** In the project's catalogue of reviewed plugins. */
  reviewed: boolean;
}

export interface PluginSearchResponse {
  /** The registry that answered (`SWITCHBOARD_NPM_REGISTRY`). */
  registry: string;
  results: PluginSearchResult[];
}

export interface CatalogueEntry {
  package: string;
  displayName: string;
  description: string;
  kinds: PluginKind[];
  reviewed: boolean;
  installed: boolean;
  latestVersion: string;
  homepage?: string;
}

// ---------------------------------------------------------------------------------------------
// Notifiers and secret providers (the remaining instance kinds)
// ---------------------------------------------------------------------------------------------

export interface InstanceSummary {
  id: string;
  kind: 'notifier' | 'secret_provider';
  typeId: string;
  typeName: string;
  /** The type's declared icon (see `SourceSummary.typeIcon`). */
  typeIcon: string | null;
  name: string;
  enabled: boolean;
  status: StatusLabel;
  health: Health | null;
  settings: Record<string, unknown>;
  settingsSchema: JSONSchema;
  instanceError: string | null;
  /**
   * Secret providers only: the sources, executors and notifiers whose settings reference
   * `secret://<this name>/…`, with their status now. Creating, enabling, disabling, editing or
   * reloading a provider rebuilds them first, so a mutation's response shows the outcome.
   */
  dependents?: SecretProviderDependentDTO[];
}

/** An instance that resolves secrets through a provider (see `InstanceSummary.dependents`). */
export interface SecretProviderDependentDTO {
  kind: 'source' | 'executor' | 'notifier';
  id: string;
  name: string;
  status: StatusLabel;
  /** Why it is not running (`secret_error: …` when a reference no longer resolves). */
  instanceError: string | null;
}

export interface CreateInstanceRequest extends Reasoned {
  typeId: string;
  name: string;
  settings: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdateInstanceRequest extends Reasoned {
  name?: string;
  settings?: Record<string, unknown>;
}

/** Something whose settings (or, for a process, whose document) hold a `secret://` reference. */
export interface SecretUserDTO {
  kind: 'source' | 'executor' | 'notifier' | 'secret_provider' | 'process';
  id: string;
  name: string;
  /** Dotted path of the field holding the reference (`apiKey`, `executor.target.token`). */
  field: string;
}

/**
 * One secret a provider lists. Names only: the API never returns a secret value, nor anything
 * derived from one.
 */
export interface ProviderSecretDTO {
  name: string;
  /** `secret://<provider>/<name>`, ready to paste into a secret field. */
  ref: string;
  description?: string;
  updatedAt?: Iso;
  usedBy: SecretUserDTO[];
}

/** A reference to this provider whose name the provider does not list (a broken reference). */
export interface MissingSecretDTO {
  name: string;
  ref: string;
  usedBy: SecretUserDTO[];
}

/** GET /secret-providers/:id/secrets */
export interface ProviderSecretsResponse {
  providerId: string;
  /** The provider's name: the `<provider>` in `secret://<provider>/<name>`. */
  provider: string;
  /**
   * False when the provider cannot list (its plugin has no `list()`, it is disabled or not
   * running, or listing failed); `error` says why and `secrets` and `missing` are empty.
   */
  available: boolean;
  error?: string;
  secrets: ProviderSecretDTO[];
  missing: MissingSecretDTO[];
}

// ---------------------------------------------------------------------------------------------
// Settings, users, audit, export, about
// ---------------------------------------------------------------------------------------------

export interface RetentionSettings {
  eventsDays: number;
  rawBodiesDays: number;
  dispatchesDays: number;
  meterReadingsDays: number;
  statsHourlyDays: number;
}

export interface GlobalSettings {
  timezone: string;
  defaultQuietHours: { start: string; end: string; days?: number[] } | null;
  meterStalenessMinutes: number;
  retention: RetentionSettings;
  oidc: { issuer: string; clientId: string; allowedDomains: string[] } | null;
  systemNotifierId: string | null;
  sourceSilenceMinutes: number;
  export: {
    schedule: string | null;
    sourceId: string | null;
    repository: string | null;
    path: string | null;
    branch: string | null;
  };
}

export interface UpdateSettingsRequest extends Reasoned {
  settings: Partial<GlobalSettings>;
}

export interface CreateUserRequest extends Reasoned {
  email: string;
  role: Role;
  /** Optional temporary password; the user must change it at first sign-in. */
  password?: string;
}

export interface UpdateUserRequest extends Reasoned {
  role: Role;
}

export interface ApiTokenDTO {
  id: string;
  name: string;
  role: Role;
  createdAt: Iso;
  lastUsedAt: Iso | null;
  revokedAt: Iso | null;
}

export interface CreateApiTokenRequest extends Reasoned {
  name: string;
  role: Role;
}

export interface CreateApiTokenResponse {
  token: ApiTokenDTO;
  /** Shown once. */
  secret: string;
}

export interface AuditEntry {
  id: number;
  at: Iso;
  actor: string;
  scope: string;
  targetId: string | null;
  targetName: string | null;
  field: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface AuditQuery {
  scope?: string;
  target?: string;
  actor?: string;
  cursor?: string;
  limit?: number;
}

export interface ApplyRequest {
  yaml: string;
  dryRun?: boolean;
  reason: string;
}

export interface ApplyResponse {
  dryRun: boolean;
  changes: { kind: string; name: string; action: 'create' | 'update' | 'unchanged' | 'delete' }[];
  errors: string[];
}

export interface AboutResponse {
  version: string;
  sdkVersion: string;
  replicas: {
    id: string;
    hostname: string;
    version: string;
    startedAt: Iso;
    heartbeatAt: Iso;
    live: boolean;
  }[];
  database: { ok: boolean; version: string | null };
  plugins: number;
  evaluation: boolean;
  publicUrl: string;
}
