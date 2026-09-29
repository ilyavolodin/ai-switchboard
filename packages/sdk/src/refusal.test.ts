import { describe, expect, it } from 'vitest';

import { isInvokeError } from './errors.js';
import { makeResponse, type HttpResponse } from './http.js';
import { refusalFor, type RefusalOptions } from './refusal.js';

const now = new Date('2026-09-29T12:00:00Z');

function res(status: number, headers: Record<string, string> = {}): HttpResponse {
  return makeResponse(status, headers, Buffer.from(''));
}

const base: RefusalOptions = { message: (r) => `Acme answered ${r.status}` };

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe('refusalFor', () => {
  it.each([
    ['a 429 with retry-after', res(429, { 'retry-after': '30' }), 30],
    ['a 429 with no retry-after uses the default', res(429), 60],
    ['a 429 with an HTTP date', res(429, { 'retry-after': 'Tue, 29 Sep 2026 12:02:00 GMT' }), 120],
  ])('returns failed with retryAfterSeconds for %s', (_label, response, seconds) => {
    expect(refusalFor(response, now, base)).toEqual({
      status: 'failed',
      retryAfterSeconds: seconds,
      errors: ['Acme answered 429'],
    });
  });

  it('uses the rate-limit hooks and message', () => {
    const result = refusalFor(res(403, { 'x-reset': '90' }), now, {
      ...base,
      isRateLimited: (r) => r.status === 403,
      retryAfterSeconds: (r) => Number(r.headers['x-reset']),
      rateLimitMessage: () => 'rate limited',
      defaultRetryAfterSeconds: 5,
    });
    expect(result).toEqual({ status: 'failed', retryAfterSeconds: 90, errors: ['rate limited'] });
  });

  it('returns held when the held hook names a reason', () => {
    const held = (r: HttpResponse): string | undefined => (r.status === 423 ? 'paused' : undefined);
    expect(refusalFor(res(423), now, { ...base, held })).toEqual({
      status: 'held',
      reason: 'paused',
    });
  });

  it.each([
    ['a 4xx is definitive', res(422), {}, { status: 422, definitive: true }],
    [
      'a 503 is retryable',
      res(503, { 'retry-after': '7' }),
      {},
      { status: 503, definitive: false, retryAfterSeconds: 7 },
    ],
    ['a 500 is neither', res(500), {}, { status: 500, definitive: false }],
    [
      'a retryable status becomes a 503',
      res(529),
      { retryableStatuses: [529] },
      { status: 503, definitive: false },
    ],
  ])('throws an InvokeError: %s', (_label, response, extra, expected) => {
    const err = thrown(() => refusalFor(response, now, { ...base, ...extra }));
    expect(isInvokeError(err)).toBe(true);
    expect(err).toMatchObject({ ...expected, message: `Acme answered ${response.status}` });
  });
});
