/**
 * Shared primitive types used across every plugin interface.
 */

/**
 * A JSON Schema (draft 2020-12) document. UI annotations: `x-secret`, `x-widget`, `x-group`,
 * `x-order`, `x-placeholder`, `x-help`, `x-enumLabels` (`{ "<value>": "<label>" }`) and
 * `x-warning` (`{ when: <schema>, message }`: a red
 * warning under the field while its value matches `when`). See the plugin author guide.
 */
export type JSONSchema = Record<string, unknown>;

/** Instance settings after `secret://` references have been resolved to their values. */
export type Settings = Record<string, unknown>;

/** A JSONata expression. */
export type Expr = string;

/** ISO-8601 timestamp string. */
export type IsoDateTime = string;

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface Health {
  status: HealthStatus;
  message?: string;
  checkedAt: IsoDateTime;
}

/** A raw inbound HTTP request, as ingress received it. Header names are lower-cased. */
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
  /** A short sentence template shown in the UI, e.g. "Add label {{label}}". */
  describe?: string;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}

/** Declared I/O a plugin may perform, shown at install time and enforced for SDK-provided I/O. */
export interface Capabilities {
  /** Host globs the plugin's HttpClient may reach, e.g. `api.github.com`, `*.atlassian.net`, `*`. */
  network?: string[];
  /** Secret names the plugin expects to be given (documentation; resolution is by reference). */
  secrets?: string[];
}
