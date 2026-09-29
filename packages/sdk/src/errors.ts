import type { SecretProvider } from './types/notifier.js';

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

/** A request targeted a host outside the plugin's declared network capability. */
export class CapabilityError extends Error {
  override readonly name = 'CapabilityError';
}

/**
 * Thrown by a destination's `invoke` to describe a backend refusal.
 *
 * - `status: 503` or `sent: false` → the core may retry.
 * - `definitive: true` (a 4xx the backend will repeat) → the run is `failed`.
 * - anything else → `uncertain` for non-idempotent destinations.
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

export function isCapabilityError(err: unknown): err is CapabilityError {
  return err instanceof Error && err.name === 'CapabilityError';
}

/** Thrown by a secret provider's `resolve` for an unknown name. The message never carries a value. */
export class SecretNotFoundError extends Error {
  override readonly name = 'SecretNotFoundError';
}

export function isSecretNotFoundError(err: unknown): err is SecretNotFoundError {
  return err instanceof Error && err.name === 'SecretNotFoundError';
}

/** Thrown by `ctx.secrets` when a rotated credential cannot be stored. Never carries the value. */
export class SecretStoreError extends Error {
  override readonly name = 'SecretStoreError';
}

export function isSecretStoreError(err: unknown): err is SecretStoreError {
  return err instanceof Error && err.name === 'SecretStoreError';
}

/** Keys of `ctx.secrets`: lower-case letters, digits, `-` and `_`, at most 64. */
export const SECRET_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A provider that can store rotated credentials: it implements both `set` and `delete`. */
export function isWritableSecretProvider(
  provider: SecretProvider,
): provider is SecretProvider & Required<Pick<SecretProvider, 'set' | 'delete'>> {
  return typeof provider.set === 'function' && typeof provider.delete === 'function';
}

/**
 * Handle 429 (return `retryAfterSeconds` in the `InvokeResult`) and backend-specific states
 * such as "paused" before calling this.
 */
export function invokeErrorForStatus(
  status: number,
  message: string,
  options: { retryAfterSeconds?: number; cause?: unknown } = {},
): InvokeError {
  const cause = options.cause !== undefined ? { cause: options.cause } : {};
  if (status === 503) {
    return new InvokeError(message, {
      status,
      ...(options.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: options.retryAfterSeconds }
        : {}),
      ...cause,
    });
  }
  if (status >= 400 && status < 500) {
    return new InvokeError(message, { status, definitive: true, ...cause });
  }
  return new InvokeError(message, { status, ...cause });
}
