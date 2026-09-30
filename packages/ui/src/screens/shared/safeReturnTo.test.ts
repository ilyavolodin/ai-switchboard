import { describe, expect, it } from 'vitest';

import { safeReturnTo } from './safeReturnTo.js';

describe('safeReturnTo', () => {
  it.each([
    [{ from: '/processes?status=breaker' }, '/login', '/processes?status=breaker'],
    [{ from: '/login' }, '/login', '/'],
    [{ from: '/login?next=1' }, '/login', '/'],
    [{ from: '/change-password' }, '/change-password', '/'],
    [{ from: 'https://evil.example' }, '/login', '/'],
    [{ from: '//evil.example/path' }, '/login', '/'],
    [{ from: 42 }, '/login', '/'],
    [null, '/login', '/'],
    [undefined, '/login', '/'],
  ])('%j from %s → %s', (state, own, expected) => {
    expect(safeReturnTo(state, own)).toBe(expected);
  });
});
