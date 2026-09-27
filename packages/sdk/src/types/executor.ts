import type {
  ActionResult,
  ActionSpec,
  Health,
  IsoDateTime,
  JSONSchema,
  RawRequest,
  Settings,
} from './common.js';
import type { PluginContext } from './context.js';

/** What a process supplies to name what to run; validated against `targetSchema`. */
export type Target = unknown;
/** What the input mapping produced; validated against `inputSchema`. */
export type Input = unknown;

export type RunMode = 'event' | 'sweep' | 'manual';

/** The core's view of one run, handed to executor methods. */
export interface RunHandle {
  /** Core run id (uuid). Echo it back in callbacks and correlation inputs. */
  id: string;
  processId: string;
  processName: string;
  mode: RunMode;
  /** When true, the executor should validate and simulate without doing work, if it can. */
  dryRun: boolean;
  /** Set once `invoke` returned one. */
  externalId?: string;
  externalUrl?: string;
  invokedAt?: IsoDateTime;
  /** Absolute URL the backend should POST to for `tracking = 'callback'`. */
  callbackUrl: string;
  /** When an open run becomes `unknown`. */
  deadline: IsoDateTime;
}

// Usage: per-run consumption, in dimensions the executor type declares
export interface UsageDimension {
  id: string;
  title: string;
  unit: 'count' | 'tokens' | 'seconds' | 'bytes' | 'usd' | (string & {});
  aggregate: 'sum' | 'max';
  budgetable: boolean;
}
/** Keyed by dimension id. */
export type UsageReport = Record<string, number>;

// Meters: account-level remaining capacity, read on a schedule
export interface MeterSpec {
  id: string;
  title: string;
  kind: 'window' | 'allowance' | 'spend';
  unit: string;
  /**
   * When the backend cannot report this meter, the core estimates it from its own run counts
   * against a limit the person types in. `estimate.period` is the counting window.
   */
  estimate?: { period: 'day' | 'hour' | 'week'; defaultLimit?: number };
  /** The meter shown in the top bar's capacity strip. At most one per executor type. */
  primary?: boolean;
}

export interface MeterReading {
  id: string;
  used?: number;
  limit?: number;
  /** 0–100 */
  utilization: number;
  resetsAt?: IsoDateTime;
  observedAt: IsoDateTime;
}

export interface InvokeResult {
  /** Session id, workflow run id, request id. */
  externalId?: string;
  /** Where a person can watch it. */
  externalUrl?: string;
  /**
   * `completed`/`failed` only for sync executors. `held` means the backend refused because the
   * target is paused or disabled on its side; `reason` names why.
   */
  status: 'started' | 'completed' | 'failed' | 'held';
  reason?: string;
  /** Sync executors: the response body. */
  result?: unknown;
  /** Sync executors: usage known at completion. */
  usage?: UsageReport;
  /** When the backend said it is out of capacity. Opens a soft-hold on the instance. */
  retryAfterSeconds?: number;
  errors?: string[];
}

export interface RunStatus {
  state: 'running' | 'ok' | 'error' | 'unknown';
  outputs?: number;
  errors?: string[];
  usage?: UsageReport;
  finishedAt?: IsoDateTime;
  externalUrl?: string;
}

export interface CallbackResult {
  runId: string;
  status: RunStatus;
}

/** A live executor object, one per enabled executor instance. */
export interface Executor {
  /**
   * Start work. Throw `TransportError` (or let `HttpClient` throw it) so the core can tell
   * whether the request may have reached the backend.
   */
  invoke(target: Target, input: Input, run: RunHandle): Promise<InvokeResult>;
  /** `tracking = 'poll'` */
  poll?(run: RunHandle): Promise<RunStatus>;
  /** `tracking = 'callback'`. Return `null` to reject (unsigned, unknown run). */
  verifyCallback?(req: RawRequest): CallbackResult | null;
  readMeters?(): Promise<MeterReading[]>;
  act?(action: string, args: unknown): Promise<ActionResult>;
  health(): Promise<Health>;
}

export type TrackingMode = 'sync' | 'poll' | 'callback' | 'none';

export interface ExecutorType {
  /** e.g. `'claude-routines'` */
  id: string;
  displayName: string;
  description?: string;
  /** Per instance: account credentials, base URL. */
  settingsSchema: JSONSchema;
  /** Per process: what to run (routine id, workflow file, URL). */
  targetSchema: JSONSchema;
  /** What the process's input mapping must produce. */
  inputSchema: JSONSchema;
  /** Example target and input, used by the conformance kit and the editor's placeholder. */
  examples?: { target: Target; input: Input }[];
  /**
   * The tracking mode. An executor whose mode depends on the process's target (the generic
   * `http` executor) declares the default here and implements `trackingFor`.
   */
  tracking: TrackingMode;
  trackingFor?(target: Target): TrackingMode;
  /** May the core retry an invoke whose response was lost? */
  idempotentInvoke: boolean;
  idempotentFor?(target: Target): boolean;
  /** What this backend reports per run (may be empty). */
  usage: UsageDimension[];
  /** Instance-specific dimensions (the `http` executor declares them per instance). */
  usageFor?(settings: Settings): UsageDimension[];
  /** What this backend reports about its remaining capacity. */
  meters?: MeterSpec[];
  metersFor?(settings: Settings): MeterSpec[];
  actions?: ActionSpec[];
  create(settings: Settings, ctx: PluginContext): Executor;
}
