import { describe, expect, it } from 'vitest';

import { gate, type GateInput } from './gate.js';
import { inQuietHours } from './quiet-hours.js';

const now = new Date('2026-01-07T15:00:00Z'); // Wednesday

function input(patch: Partial<GateInput> = {}): GateInput {
  return {
    kind: 'event',
    dryRun: false,
    process: { enabled: true },
    sources: [{ id: 's1', enabled: true }],
    destination: {
      exists: true,
      enabled: true,
      pluginAvailable: true,
      live: true,
      health: { status: 'healthy', checkedAt: now.toISOString() },
    },
    breaker: { state: 'closed', openedAt: null, cooldownMinutes: 60 },
    quietHours: null,
    defaultTimezone: 'UTC',
    approval: { rule: 'none', required: false, state: 'none' },
    ...patch,
  };
}

const base = input();

describe('gate order and reasons', () => {
  it('passes with every check recorded in order', () => {
    const out = gate(base, now);
    expect(out.pass).toBe(true);
    expect(out.checks.map((c) => c.check)).toEqual([
      'process_enabled',
      'sources_enabled',
      'destination_enabled',
      'plugin_available',
      'destination_healthy',
      'breaker_closed',
      'outside_quiet_hours',
      'approval',
    ]);
  });

  it.each<[string, Partial<GateInput>, string]>([
    ['process disabled', { process: { enabled: false } }, 'process_disabled'],
    [
      'a source disabled',
      {
        sources: [
          { id: 's1', enabled: true },
          { id: 's2', enabled: false },
        ],
      },
      'source_disabled',
    ],
    [
      'destination missing',
      { destination: { ...base.destination, exists: false } },
      'destination_disabled',
    ],
    [
      'destination disabled',
      { destination: { ...base.destination, enabled: false } },
      'destination_disabled',
    ],
    [
      'plugin unavailable',
      { destination: { ...base.destination, pluginAvailable: false, live: false } },
      'plugin_unavailable',
    ],
    [
      'no live object (secret error)',
      { destination: { ...base.destination, live: false, instanceError: 'secret_error: x' } },
      'destination_unhealthy',
    ],
    [
      'destination unhealthy',
      {
        destination: {
          ...base.destination,
          health: { status: 'unhealthy', checkedAt: '', message: '401' },
        },
      },
      'destination_unhealthy',
    ],
    [
      'breaker open',
      {
        breaker: { state: 'open', openedAt: new Date(now.getTime() - 60_000), cooldownMinutes: 60 },
      },
      'breaker_open',
    ],
    ['quiet hours', { quietHours: { start: '14:00', end: '16:00' } }, 'quiet_hours'],
    [
      'approval always',
      { approval: { rule: 'always', required: true, state: 'none' } },
      'awaiting_approval',
    ],
    [
      'approval expression true',
      { approval: { rule: 'events[0]', required: true, state: 'none' } },
      'awaiting_approval',
    ],
  ])('%s → held %s', (_name, patch, reason) => {
    const out = gate(input(patch), now);
    expect(out.pass).toBe(false);
    if (!out.pass) expect(out.reason).toBe(reason);
    expect(out.checks.at(-1)?.pass).toBe(false);
  });

  it('stops at the first failure: a disabled process is not also reported as quiet hours', () => {
    const out = gate(
      input({ process: { enabled: false }, quietHours: { start: '00:00', end: '23:59' } }),
      now,
    );
    expect(out.pass).toBe(false);
    if (!out.pass) expect(out.reason).toBe('process_disabled');
    expect(out.checks).toHaveLength(1);
  });

  it('breaker closes after the cooldown and the batch passes', () => {
    const out = gate(
      input({
        breaker: {
          state: 'open',
          openedAt: new Date(now.getTime() - 61 * 60_000),
          cooldownMinutes: 60,
        },
      }),
      now,
    );
    expect(out.pass).toBe(true);
    expect(out.breakerClosed).toBe(true);
  });

  it('a breaker with cooldown 0 stays open until reset by hand', () => {
    const out = gate(
      input({ breaker: { state: 'open', openedAt: new Date(0), cooldownMinutes: 0 } }),
      now,
    );
    expect(out.pass).toBe(false);
  });
});

describe('approval hold and release', () => {
  it.each<[string, GateInput['approval'], boolean]>([
    ['none passes', { rule: 'none', required: false, state: 'none' }, true],
    ['always holds', { rule: 'always', required: true, state: 'none' }, false],
    ['always passes once approved', { rule: 'always', required: true, state: 'approved' }, true],
    ['expression false passes', { rule: "mode = 'sweep'", required: false, state: 'none' }, true],
    [
      'expression error holds (fail closed)',
      { rule: 'bad(', required: true, state: 'none', error: 'syntax' },
      false,
    ],
  ])('%s', (_name, approval, pass) => {
    expect(gate(input({ approval }), now).pass).toBe(pass);
  });

  it('a dry run skips the approval gate but not the others', () => {
    expect(
      gate(
        input({ dryRun: true, approval: { rule: 'always', required: true, state: 'none' } }),
        now,
      ).pass,
    ).toBe(true);
    expect(gate(input({ dryRun: true, process: { enabled: false } }), now).pass).toBe(false);
  });
});

describe('quiet hours', () => {
  it.each([
    ['inside a daytime window', { start: '09:00', end: '17:00' }, '2026-01-07T12:00:00Z', true],
    ['at the end (exclusive)', { start: '09:00', end: '17:00' }, '2026-01-07T17:00:00Z', false],
    ['overnight, evening part', { start: '22:00', end: '07:00' }, '2026-01-07T23:30:00Z', true],
    ['overnight, morning part', { start: '22:00', end: '07:00' }, '2026-01-08T06:59:00Z', true],
    ['overnight, daytime', { start: '22:00', end: '07:00' }, '2026-01-08T12:00:00Z', false],
    ['empty window', { start: '09:00', end: '09:00' }, '2026-01-07T09:00:00Z', false],
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
