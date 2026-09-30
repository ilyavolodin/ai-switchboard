import { describe, expect, it } from 'vitest';

import { inQuietHours } from './quiet-hours.js';

describe('inQuietHours', () => {
  it.each([
    ['inside a daytime window', { start: '09:00', end: '17:00' }, '2026-01-07T12:00:00Z', true],
    ['at the end (exclusive)', { start: '09:00', end: '17:00' }, '2026-01-07T17:00:00Z', false],
    ['overnight, evening part', { start: '22:00', end: '07:00' }, '2026-01-07T23:30:00Z', true],
    ['overnight, morning part', { start: '22:00', end: '07:00' }, '2026-01-08T06:59:00Z', true],
    ['overnight, daytime', { start: '22:00', end: '07:00' }, '2026-01-08T12:00:00Z', false],
    ['empty window', { start: '09:00', end: '09:00' }, '2026-01-07T09:00:00Z', false],
    [
      'a malformed time is no window',
      { start: '9:00', end: '17:00' },
      '2026-01-07T12:00:00Z',
      false,
    ],
    [
      'in the named timezone',
      { start: '09:00', end: '17:00', timezone: 'America/New_York' },
      '2026-01-07T15:00:00Z',
      true,
    ],
    [
      'outside in the named timezone',
      { start: '09:00', end: '17:00', timezone: 'America/New_York' },
      '2026-01-07T13:00:00Z',
      false,
    ],
    [
      'an unknown timezone falls back to UTC',
      { start: '09:00', end: '17:00', timezone: 'Nowhere/Else' },
      '2026-01-07T12:00:00Z',
      true,
    ],
    [
      'only on listed days (Wed=3)',
      { start: '09:00', end: '17:00', days: [3] },
      '2026-01-07T12:00:00Z',
      true,
    ],
    [
      'not on other days',
      { start: '09:00', end: '17:00', days: [1, 2] },
      '2026-01-07T12:00:00Z',
      false,
    ],
    // Friday 22:00 → Saturday 07:00 belongs to Friday (5).
    [
      'overnight morning belongs to the start day',
      { start: '22:00', end: '07:00', days: [5] },
      '2026-01-10T03:00:00Z',
      true,
    ],
    [
      'overnight morning of a non-listed start day',
      { start: '22:00', end: '07:00', days: [6] },
      '2026-01-10T03:00:00Z',
      false,
    ],
  ])('%s', (_name, window, at, expected) => {
    expect(inQuietHours(window, new Date(at), 'UTC')).toBe(expected);
  });
});
