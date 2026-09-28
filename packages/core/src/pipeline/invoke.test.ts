import { describe, expect, it } from 'vitest';

import { InvokeError, TransportError } from '@ai-switchboard/sdk';

import {
  classifyInvoke,
  effectiveInvokeTimeoutSeconds,
  invokeAttemptDeadline,
  MAX_INVOKE_ATTEMPTS,
  statusAfterStart,
  type InvokeOutcome,
} from './invoke.js';

const error = (e: unknown): InvokeOutcome => ({ kind: 'error', error: e });
const result = (r: object): InvokeOutcome => ({ kind: 'result', result: r as never });

/** A copy of an error from another SDK instance: same name and fields, different class. */
function foreign(name: string, fields: Record<string, unknown>): Error {
  const e = new Error('foreign');
  Object.defineProperty(e, 'name', { value: name });
  Object.assign(e, fields);
  return e;
}

describe('effective invoke timeout', () => {
  it.each<[string, Parameters<typeof effectiveInvokeTimeoutSeconds>[0], number]>([
    ['nothing set → core default 300 s', {}, 300],
    ['type default only', { typeDefault: 60 }, 60],
    ['per-target beats the type default', { perTarget: 45, typeDefault: 60 }, 45],
    ['instance cap beats per-target and type', { cap: 20, perTarget: 45, typeDefault: 60 }, 20],
    [
      'a per-target undefined falls through to the type',
      { perTarget: undefined, typeDefault: 90 },
      90,
    ],
    ['garbage at a level is ignored', { cap: 'x', perTarget: Number.NaN, typeDefault: -5 }, 300],
    ['clamped up to 1 s', { cap: 0.2 }, 1],
    ['clamped down to 3600 s', { perTarget: 99_999 }, 3600],
  ])('%s', (_name, levels, expected) => {
    expect(effectiveInvokeTimeoutSeconds(levels)).toBe(expected);
  });

  it('an attempt deadline covers the step budget, the timeout and a margin', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    expect(invokeAttemptDeadline(start, 300, 50).toISOString()).toBe('2026-01-01T00:06:20.000Z');
  });
});

describe('the idempotency rule', () => {
  it.each<[string, boolean, InvokeOutcome, string]>([
    [
      'no answer within the invoke timeout, non-idempotent → uncertain',
      false,
      { kind: 'timeout', seconds: 30 },
      'uncertain',
    ],
    [
      'no answer within the invoke timeout, idempotent → retry',
      true,
      { kind: 'timeout', seconds: 30 },
      'retry',
    ],
    [
      'connection refused (not sent) → retry',
      false,
      error(new TransportError('ECONNREFUSED', { sent: false, code: 'ECONNREFUSED' })),
      'retry',
    ],
    [
      'timeout after send, non-idempotent → uncertain',
      false,
      error(new TransportError('timeout', { sent: true })),
      'uncertain',
    ],
    [
      'timeout after send, idempotent → retry with the same run id',
      true,
      error(new TransportError('timeout', { sent: true })),
      'retry',
    ],
    [
      '503 → retry even for non-idempotent',
      false,
      error(new InvokeError('unavailable', { status: 503 })),
      'retry',
    ],
    [
      '500 after send, non-idempotent → uncertain',
      false,
      error(new InvokeError('boom', { status: 500 })),
      'uncertain',
    ],
    [
      '500 after send, idempotent → retry',
      true,
      error(new InvokeError('boom', { status: 500 })),
      'retry',
    ],
    [
      'definitive 400 → failed',
      false,
      error(new InvokeError('bad', { status: 400, definitive: true })),
      'failed',
    ],
    [
      'unexpected exception, non-idempotent → uncertain',
      false,
      error(new Error('bug')),
      'uncertain',
    ],
    [
      'duck-typed foreign TransportError not sent → retry',
      false,
      error(foreign('TransportError', { sent: false })),
      'retry',
    ],
    [
      'duck-typed foreign InvokeError 503 → retry',
      false,
      error(foreign('InvokeError', { status: 503, sent: true, definitive: false })),
      'retry',
    ],
    ['started', false, result({ status: 'started', externalId: 'x' }), 'started'],
    ['completed', false, result({ status: 'completed', result: { a: 1 } }), 'completed'],
    ['paused → held', false, result({ status: 'held', reason: 'paused' }), 'held'],
  ])('%s', (_name, idempotent, outcome, action) => {
    expect(classifyInvoke({ idempotent, attempt: 1 }, outcome).action).toBe(action);
  });

  it('a lost response is never retried for a non-idempotent destination, at any attempt', () => {
    for (let attempt = 1; attempt <= MAX_INVOKE_ATTEMPTS; attempt++) {
      const out = classifyInvoke(
        { idempotent: false, attempt },
        error(new TransportError('reset', { sent: true })),
      );
      expect(out.action).toBe('uncertain');
    }
  });

  it('retries back off and give up after the last attempt', () => {
    const refused = error(new TransportError('refused', { sent: false }));
    const first = classifyInvoke({ idempotent: false, attempt: 1 }, refused);
    const third = classifyInvoke({ idempotent: false, attempt: 3 }, refused);
    expect(first).toMatchObject({ action: 'retry', delaySeconds: 5 });
    expect(third).toMatchObject({ action: 'retry', delaySeconds: 20 });
    expect(
      classifyInvoke({ idempotent: false, attempt: MAX_INVOKE_ATTEMPTS }, refused),
    ).toMatchObject({
      action: 'failed',
      reason: expect.stringMatching(/^retries_exhausted/),
    });
  });

  it('401/403 fails and marks the destination unhealthy', () => {
    for (const status of [401, 403]) {
      const out = classifyInvoke(
        { idempotent: false, attempt: 1 },
        error(new InvokeError('no', { status })),
      );
      expect(out).toMatchObject({ action: 'failed', unhealthy: true });
    }
  });

  it('429 with retryAfterSeconds opens a soft-hold without uncertainty', () => {
    const viaResult = classifyInvoke(
      { idempotent: false, attempt: 1 },
      result({ status: 'failed', retryAfterSeconds: 120 }),
    );
    expect(viaResult).toMatchObject({
      action: 'failed',
      reason: 'rate_limited',
      softHoldSeconds: 120,
    });
    const viaError = classifyInvoke(
      { idempotent: false, attempt: 1 },
      error(new InvokeError('slow down', { status: 429, retryAfterSeconds: 60 })),
    );
    expect(viaError).toMatchObject({ action: 'failed', softHoldSeconds: 60 });
  });

  it('a sync failure is a completed run with status error', () => {
    expect(
      classifyInvoke(
        { idempotent: false, attempt: 1 },
        result({ status: 'failed', errors: ['x'] }),
      ),
    ).toMatchObject({ action: 'completed', status: 'error', errors: ['x'] });
  });

  it('tracking none closes ok on start', () => {
    expect(statusAfterStart('none')).toBe('ok');
    expect(statusAfterStart('poll')).toBe('running');
    expect(statusAfterStart('callback')).toBe('running');
  });
});
