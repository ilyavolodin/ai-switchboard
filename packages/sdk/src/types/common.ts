import type { HEALTH_STATUSES } from '../constants.js';

/**
 * Draft 2020-12. The UI reads `x-*` annotations (`x-secret`, `x-widget`, `x-warning`,
 * `x-effectiveDefault`, ...); the plugin author guide lists them.
 */
export type JSONSchema = Record<string, unknown>;

/** Instance settings after `secret://` references have been resolved to their values. */
export type Settings = Record<string, unknown>;

/** JSONata. */
export type Expr = string;

export type IsoDateTime = string;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export interface Health {
  status: HealthStatus;
  message?: string;
  checkedAt: IsoDateTime;
}

/** Header names are lower-cased. */
export interface RawRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  /** The exact bytes received; signatures are computed over this. */
  body: Buffer;
  receivedAt: IsoDateTime;
  remoteAddress?: string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface ActionSpec {
  id: string;
  title: string;
  description?: string;
  argsSchema: JSONSchema;
  /** Sentence template shown in the UI, e.g. "Add label {{label}}". */
  describe?: string;
  /**
   * True when repeating the action is harmless (add a label, not post a comment). When a crash
   * leaves a step in doubt, only an idempotent action is re-run; otherwise a `before` step fails
   * the run before invoke and an `after` step is recorded `uncertain`.
   */
  idempotent?: boolean;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}

/** Shown at install time and enforced for SDK-provided I/O. */
export interface Capabilities {
  /** Host globs the plugin's HttpClient may reach, e.g. `*.atlassian.net`. */
  network?: string[];
  /**
   * Documentation only; resolution is by reference. `definePlugin` fills it from the `x-secret`
   * settings fields.
   */
  secrets?: string[];
}
