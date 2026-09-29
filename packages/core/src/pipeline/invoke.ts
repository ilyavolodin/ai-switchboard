import {
  isInvokeError,
  isTransportError,
  type InvokeResult,
  type TrackingMode,
} from '@ai-switchboard/sdk';

/**
 * The idempotency rule: a non-idempotent invoke is retried only when the request never left
 * (`sent === false`) or the backend answered 503. Anything that may have reached the backend
 * leaves the run `uncertain`, never a second invoke. Idempotent destinations retry a lost
 * response with the same run id.
 */

export const MAX_INVOKE_ATTEMPTS = 5;
export const RETRY_DELAYS_SECONDS = [5, 10, 20, 40] as const;

export function retryDelaySeconds(attempt: number): number {
  return RETRY_DELAYS_SECONDS[Math.min(attempt, RETRY_DELAYS_SECONDS.length) - 1] ?? 40;
}

export const DEFAULT_INVOKE_TIMEOUT_SECONDS = 300;
export const MIN_INVOKE_TIMEOUT_SECONDS = 1;
/** Matches the SDK's `MAX_INVOKE_TIMEOUT_SECONDS`. */
export const MAX_INVOKE_TIMEOUT_SECONDS = 3600;

function usableSeconds(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A level that is not a positive finite number falls through to the next. */
export function effectiveInvokeTimeoutSeconds(levels: {
  cap?: unknown;
  perTarget?: unknown;
  typeDefault?: unknown;
}): number {
  const chosen =
    usableSeconds(levels.cap) ??
    usableSeconds(levels.perTarget) ??
    usableSeconds(levels.typeDefault) ??
    DEFAULT_INVOKE_TIMEOUT_SECONDS;
  return Math.min(MAX_INVOKE_TIMEOUT_SECONDS, Math.max(MIN_INVOKE_TIMEOUT_SECONDS, chosen));
}

/** So recovery only calls an attempt stale once the worker running it has certainly given up. */
export const INVOKE_DEADLINE_MARGIN_SECONDS = 30;

/** When recovery may treat an attempt claimed at `startedAt` as stale. */
export function invokeAttemptDeadline(
  startedAt: Date,
  invokeTimeoutSeconds: number,
  beforeStepBudgetSeconds: number,
): Date {
  const total = invokeTimeoutSeconds + beforeStepBudgetSeconds + INVOKE_DEADLINE_MARGIN_SECONDS;
  return new Date(startedAt.getTime() + total * 1000);
}

/** A timeout is a lost response (the request may have reached the backend), not a plugin error. */
export type InvokeOutcome =
  | { kind: 'result'; result: InvokeResult }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout'; seconds: number };

export type InvokeClassification =
  | { action: 'retry'; reason: string; delaySeconds: number }
  | {
      action: 'started';
      externalId?: string;
      externalUrl?: string;
      softHoldSeconds?: number;
    }
  | {
      action: 'completed';
      status: 'ok' | 'error';
      externalId?: string;
      externalUrl?: string;
      result?: unknown;
      usage?: unknown;
      errors?: string[];
      softHoldSeconds?: number;
    }
  | { action: 'held'; reason: string; externalId?: string; externalUrl?: string }
  | {
      action: 'failed';
      reason: string;
      errors: string[];
      softHoldSeconds?: number;
      /** 401/403: mark the destination unhealthy. */
      unhealthy?: boolean;
    }
  | { action: 'uncertain'; reason: string };

function positive(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ClassifyInput {
  idempotent: boolean;
  /** 1-based, including this one. */
  attempt: number;
  maxAttempts?: number;
}

export function classifyInvoke(input: ClassifyInput, outcome: InvokeOutcome): InvokeClassification {
  const max = input.maxAttempts ?? MAX_INVOKE_ATTEMPTS;
  const retry = (reason: string): InvokeClassification =>
    input.attempt < max
      ? { action: 'retry', reason, delaySeconds: retryDelaySeconds(input.attempt) }
      : { action: 'failed', reason: `retries_exhausted: ${reason}`, errors: [reason] };
  const lost = (reason: string): InvokeClassification =>
    input.idempotent ? retry(reason) : { action: 'uncertain', reason };

  if (outcome.kind === 'result') {
    const r = outcome.result;
    const soft = positive(r.retryAfterSeconds);
    const ids = {
      ...(r.externalId !== undefined ? { externalId: r.externalId } : {}),
      ...(r.externalUrl !== undefined ? { externalUrl: r.externalUrl } : {}),
    };
    switch (r.status) {
      case 'started':
        return { action: 'started', ...ids, ...(soft ? { softHoldSeconds: soft } : {}) };
      case 'completed':
        return {
          action: 'completed',
          status: 'ok',
          ...ids,
          result: r.result,
          usage: r.usage,
          ...(r.errors ? { errors: r.errors } : {}),
          ...(soft ? { softHoldSeconds: soft } : {}),
        };
      case 'held':
        return { action: 'held', reason: r.reason ?? 'paused', ...ids };
      case 'failed':
        if (soft) {
          // Out of capacity: the backend refused before doing any work.
          return {
            action: 'failed',
            reason: 'rate_limited',
            errors: r.errors ?? [`retry after ${soft} s`],
            softHoldSeconds: soft,
          };
        }
        return {
          action: 'completed',
          status: 'error',
          ...ids,
          result: r.result,
          usage: r.usage,
          errors: r.errors ?? [r.reason ?? 'the backend reported failure'],
        };
      default:
        return lost(`malformed InvokeResult status ${JSON.stringify(r.status)}`);
    }
  }

  if (outcome.kind === 'timeout') return lost(`no answer within ${outcome.seconds} s`);

  const err = outcome.error;
  if (isTransportError(err)) {
    if (!err.sent) return retry(`not sent: ${err.message}`);
    return lost(`response lost: ${err.message}`);
  }
  if (isInvokeError(err)) {
    const soft = positive(err.retryAfterSeconds);
    if (err.status === 503) {
      return input.attempt < max
        ? {
            action: 'retry',
            reason: `503: ${err.message}`,
            delaySeconds: Math.max(retryDelaySeconds(input.attempt), soft ?? 0),
          }
        : { action: 'failed', reason: 'retries_exhausted: 503', errors: [err.message] };
    }
    if (!err.sent) return retry(`not sent: ${err.message}`);
    const unhealthy = err.status === 401 || err.status === 403;
    if (err.definitive || unhealthy) {
      return {
        action: 'failed',
        reason: err.status !== undefined ? `refused_${err.status}` : 'refused',
        errors: [err.message],
        ...(soft ? { softHoldSeconds: soft } : {}),
        ...(unhealthy ? { unhealthy: true } : {}),
      };
    }
    if (soft) {
      return {
        action: 'failed',
        reason: 'rate_limited',
        errors: [err.message],
        softHoldSeconds: soft,
      };
    }
    return lost(`${err.status ?? 'error'}: ${err.message}`);
  }
  // An unexpected exception may have happened after the request was sent.
  return lost(`exception: ${message(err)}`);
}

export function statusAfterStart(tracking: TrackingMode): 'running' | 'ok' {
  return tracking === 'none' ? 'ok' : 'running';
}
