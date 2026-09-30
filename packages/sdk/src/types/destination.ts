import type { INVOKE_STATUSES, RUN_STATES, TRACKING_MODES } from '../constants.js';
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

export interface RunHandle {
  /** Echo it back in callbacks and correlation inputs. */
  id: string;
  processId: string;
  processName: string;
  mode: RunMode;
  /** Validate and simulate without doing work, if the destination can. */
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

export interface UsageDimension {
  id: string;
  title: string;
  unit: 'count' | 'tokens' | 'seconds' | 'bytes' | 'usd' | (string & {});
  aggregate: 'sum' | 'max';
  budgetable: boolean;
}
/** Keyed by dimension id. */
export type UsageReport = Record<string, number>;

/** Account-level remaining capacity, read on a schedule. */
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
  /** The meter shown in the top bar's capacity strip. At most one per destination type. */
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

export type InvokeStatus = (typeof INVOKE_STATUSES)[number];

export type RunState = (typeof RUN_STATES)[number];

export type TrackingMode = (typeof TRACKING_MODES)[number];

export interface InvokeResult {
  externalId?: string;
  externalUrl?: string;
  /**
   * `completed`/`failed` only for sync destinations. `held` means the backend refused because the
   * target is paused or disabled on its side; `reason` names why.
   */
  status: InvokeStatus;
  reason?: string;
  /** Sync destinations: the response body. */
  result?: unknown;
  /** Sync destinations: usage known at completion. */
  usage?: UsageReport;
  /** When the backend said it is out of capacity. Opens a soft-hold on the instance. */
  retryAfterSeconds?: number;
  errors?: string[];
}

export interface RunStatus {
  state: RunState;
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

export interface Destination {
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

export interface DestinationType {
  id: string;
  displayName: string;
  description?: string;
  /** A built-in icon name (`ICON_NAMES`) or a `data:image/svg+xml;base64,…` URI of at most 8 KB. */
  icon?: string;
  /** Per instance (account credentials, base URL). */
  settingsSchema: JSONSchema;
  /** Per process: what to run. */
  targetSchema: JSONSchema;
  /** What the process's input mapping must produce. */
  inputSchema: JSONSchema;
  /** Used by the conformance kit and the editor's placeholder. */
  examples?: { target: Target; input: Input }[];
  /**
   * The tracking mode. A destination whose mode depends on the process's target (the generic
   * `http` destination) declares the default here and implements `trackingFor`.
   */
  tracking: TrackingMode;
  trackingFor?(target: Target): TrackingMode;
  /** May the core retry an invoke whose response was lost? */
  idempotentInvoke: boolean;
  idempotentFor?(target: Target): boolean;
  /**
   * Seconds the core waits for `invoke` to answer (default 300, clamped to 1–3600).
   * `invokeTimeoutFor` refines it per target; a destination's `invokeTimeoutSeconds` cap
   * overrides both. A timeout is a lost response, so the idempotency rule applies: a
   * non-idempotent run is left `uncertain`, never invoked twice. Keep the plugin's own HTTP
   * timeout below it so a slow backend surfaces as a `TransportError` first.
   */
  invokeTimeoutSeconds?: number;
  /** Invoke timeout for one target, in seconds. */
  invokeTimeoutFor?(target: Target): number | undefined;
  usage: UsageDimension[];
  /** Instance-specific usage dimensions. */
  usageFor?(settings: Settings): UsageDimension[];
  meters?: MeterSpec[];
  metersFor?(settings: Settings): MeterSpec[];
  actions?: ActionSpec[];
  create(settings: Settings, ctx: PluginContext): Destination;
}
