import {
  MAX_INVOKE_TIMEOUT_SECONDS,
  errorText,
  isInvokeError,
  isTransportError,
  type InvokeResult,
  type TrackingMode,
} from '@ai-switchboard/sdk';

import { DEFAULT_INVOKE_TIMEOUT_SECONDS, MIN_INVOKE_TIMEOUT_SECONDS } from '../domain/defaults.js';
import { addSeconds } from '../util/time.js';

/**
 * The idempotency rule: a non-idempotent invoke is retried only when the request never left
 * (`sent === false`) or the backend answered 503. Anything that may have reached the backend
 * leaves the run `uncertain`, never a second invoke. Idempotent destinations retry a lost
 * response with the same run id.
 */

export const MAX_INVOKE_ATTEMPTS = 5;
/** Nothing was sent, like a connection refused: wait for the instance to come back. */
export const NO_LIVE_INSTANCE_RETRY_SECONDS = 30;
export const RETRY_DELAYS_SECONDS = [5, 10, 20, 40] as const;

export function retryDelaySeconds(attempt: number): number {
  return RETRY_DELAYS_SECONDS[Math.min(attempt, RETRY_DELAYS_SECONDS.length) - 1] ?? 40;
}

function positive(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A level that is not a positive finite number falls through to the next. */
export function effectiveInvokeTimeoutSeconds(levels: {
  cap?: unknown;
  perTarget?: unknown;
  typeDefault?: unknown;
}): number {
  const chosen =
    positive(levels.cap) ??
    positive(levels.perTarget) ??
    positive(levels.typeDefault) ??
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
  return addSeconds(
    startedAt,
    invokeTimeoutSeconds + beforeStepBudgetSeconds + INVOKE_DEADLINE_MARGIN_SECONDS,
  );
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

export interface ClassifyInput {
  idempotent: boolean;
  /** 1-based, including this one. */
  attempt: number;
  maxAttempts?: number;
}

export function classifyInvoke(input: ClassifyInput, outcome: InvokeOutcome): InvokeClassification {
  const max = input.maxAttempts ?? MAX_INVOKE_ATTEMPTS;
  const retry = (
    reason: string,
    minDelaySeconds = 0,
    exhausted: { reason: string; errors: string[] } = {
      reason: `retries_exhausted: ${reason}`,
      errors: [reason],
    },
  ): InvokeClassification =>
    input.attempt < max
      ? {
          action: 'retry',
          reason,
          delaySeconds: Math.max(retryDelaySeconds(input.attempt), minDelaySeconds),
        }
      : { action: 'failed', ...exhausted };
  const lost = (reason: string): InvokeClassification =>
    input.idempotent ? retry(reason) : { action: 'uncertain', reason };
  /** Out of capacity: the backend refused before doing any work. */
  const rateLimited = (errors: string[], softHoldSeconds: number): InvokeClassification => ({
    action: 'failed',
    reason: 'rate_limited',
    errors,
    softHoldSeconds,
  });

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
        if (soft) return rateLimited(r.errors ?? [`retry after ${soft} s`], soft);
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
      return retry(`503: ${err.message}`, soft ?? 0, {
        reason: 'retries_exhausted: 503',
        errors: [err.message],
      });
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
    if (soft) return rateLimited([err.message], soft);
    return lost(`${err.status ?? 'error'}: ${err.message}`);
  }
  // An unexpected exception may have happened after the request was sent.
  return lost(`exception: ${errorText(err)}`);
}

export function statusAfterStart(tracking: TrackingMode): 'running' | 'ok' {
  return tracking === 'none' ? 'ok' : 'running';
}
