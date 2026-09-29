import { invokeErrorForStatus } from './errors.js';
import { parseRetryAfter, type HttpResponse } from './http.js';
import type { InvokeResult } from './types/destination.js';

export const DEFAULT_RETRY_AFTER_SECONDS = 60;

export interface RefusalOptions {
  /** The run's error text for this response, e.g. `Acme answered 422: bad input`. */
  message: (res: HttpResponse) => string;
  /** Error text when rate limited; defaults to `message`. */
  rateLimitMessage?: (res: HttpResponse) => string;
  /** Defaults to `status === 429`. */
  isRateLimited?: (res: HttpResponse) => boolean;
  /** Seconds until capacity returns; defaults to the `retry-after` header. */
  retryAfterSeconds?: (res: HttpResponse, now: Date) => number | undefined;
  /** Used when a rate-limited response names no retry time. Defaults to 60. */
  defaultRetryAfterSeconds?: number;
  /** A reason (`paused`, `disabled`) when the backend refused because the target is off. */
  held?: (res: HttpResponse) => string | undefined;
  /** Statuses that mean "not processed, safe to retry", treated like a 503. */
  retryableStatuses?: readonly number[];
}

/**
 * Maps a non-2xx response per the destination rules: a rate limit is returned as `failed` with
 * `retryAfterSeconds`, a held reason as `held`, and anything else is thrown as an `InvokeError`
 * (`definitive` for a 4xx, retryable for a 503).
 */
export function refusalFor(res: HttpResponse, now: Date, options: RefusalOptions): InvokeResult {
  const retryAfter =
    options.retryAfterSeconds?.(res, now) ?? parseRetryAfter(res.headers['retry-after'], now);
  const rateLimited = options.isRateLimited?.(res) ?? res.status === 429;
  if (rateLimited) {
    return {
      status: 'failed',
      retryAfterSeconds:
        retryAfter ?? options.defaultRetryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
      errors: [(options.rateLimitMessage ?? options.message)(res)],
    };
  }
  const reason = options.held?.(res);
  if (reason !== undefined) return { status: 'held', reason };
  const status = options.retryableStatuses?.includes(res.status) === true ? 503 : res.status;
  throw invokeErrorForStatus(
    status,
    options.message(res),
    retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {},
  );
}
