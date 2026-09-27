/**
 * Thrown by `HttpClient` when a request could not complete. `sent` says whether the request may
 * have reached the server: the core retries a non-idempotent invoke only when `sent` is false.
 */
export class TransportError extends Error {
  override readonly name = 'TransportError';
  readonly sent: boolean;
  readonly code: string | undefined;

  constructor(message: string, options: { sent: boolean; code?: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.sent = options.sent;
    this.code = options.code;
  }
}

/** Thrown by `HttpClient` when a request targets a host outside the plugin's declared network capability. */
export class CapabilityError extends Error {
  override readonly name = 'CapabilityError';
}

/**
 * Thrown by an executor's `invoke` to describe a backend refusal precisely.
 *
 * - `status: 503` or `sent: false` → the core may retry.
 * - `definitive: true` (a 4xx the backend will repeat) → the run is `failed`.
 * - anything else → `uncertain` for non-idempotent executors.
 */
export class InvokeError extends Error {
  override readonly name = 'InvokeError';
  readonly status: number | undefined;
  readonly sent: boolean;
  readonly definitive: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    options: {
      status?: number;
      sent?: boolean;
      definitive?: boolean;
      retryAfterSeconds?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.status = options.status;
    this.sent = options.sent ?? true;
    this.definitive = options.definitive ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Duck-typed checks so errors survive being thrown across duplicate SDK copies. */
export function isTransportError(err: unknown): err is TransportError {
  return err instanceof Error && err.name === 'TransportError' && 'sent' in err;
}

export function isInvokeError(err: unknown): err is InvokeError {
  return err instanceof Error && err.name === 'InvokeError' && 'definitive' in err;
}
