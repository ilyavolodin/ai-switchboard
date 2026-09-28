import { describe, expect, it } from 'vitest';

import { emailKey, throttleDecision, type ThrottleLimit } from './throttle.js';

const NOW = new Date('2026-05-01T12:00:00.000Z');
const WINDOW = 5 * 60_000;
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const times = (n: number, from: number, step = 1) =>
  Array.from({ length: n }, (_, i) => ago(from - i * step));

const ip: ThrottleLimit = { key: 'ip:10.0.0.1', max: 10 };
const email: ThrottleLimit = { key: 'email:abc', max: 5 };

describe('throttleDecision (sliding window)', () => {
  it.each([
    ['no failures', new Map<string, Date[]>(), true],
    ['four email failures', new Map([['email:abc', times(4, 60)]]), true],
    ['five email failures', new Map([['email:abc', times(5, 60)]]), false],
    ['nine IP failures', new Map([['ip:10.0.0.1', times(9, 60)]]), true],
    ['ten IP failures', new Map([['ip:10.0.0.1', times(10, 60)]]), false],
    // Failures older than the window do not count.
    ['five email failures, all older than 5 min', new Map([['email:abc', times(5, 400)]]), true],
    ['another key failing', new Map([['email:other', times(20, 60)]]), true],
  ])('%s → allowed %s', (_label, failures, allowed) => {
    expect(throttleDecision([ip, email], failures, NOW, WINDOW).allowed).toBe(allowed);
  });

  it('waits until the oldest counted failure leaves the window', () => {
    // Five failures at 120 s, 110 s, … 80 s ago: the oldest ages out 180 s from now.
    const d = throttleDecision([email], new Map([['email:abc', times(5, 120, 10)]]), NOW, WINDOW);
    expect(d).toEqual({ allowed: false, retryAfterSeconds: 180, lockedKey: 'email:abc' });
  });

  it('counts only the newest max failures for the wait', () => {
    // Seven failures: the wait is set by the fifth newest (110 s ago), not the oldest (120 s).
    const d = throttleDecision([email], new Map([['email:abc', times(7, 120, 5)]]), NOW, WINDOW);
    expect(d.retryAfterSeconds).toBe(190);
  });

  it('reports the key that frees up last when several are locked', () => {
    const d = throttleDecision(
      [ip, email],
      new Map([
        ['ip:10.0.0.1', times(10, 290)],
        ['email:abc', times(5, 30)],
      ]),
      NOW,
      WINDOW,
    );
    expect(d.lockedKey).toBe('email:abc');
    expect(d.retryAfterSeconds).toBe(270);
  });

  it('never asks to wait less than a second', () => {
    const d = throttleDecision([email], new Map([['email:abc', times(5, 299.9)]]), NOW, WINDOW);
    expect(d.retryAfterSeconds).toBe(1);
  });
});

describe('emailKey', () => {
  it('normalises case and whitespace and never holds the address', () => {
    expect(emailKey('  Ada@Example.COM ')).toBe(emailKey('ada@example.com'));
    expect(emailKey('ada@example.com')).not.toContain('ada');
    expect(emailKey('ada@example.com')).toMatch(/^email:[0-9a-f]{64}$/);
  });
});
