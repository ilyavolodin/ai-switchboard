import { describe, expect, it } from 'vitest';

import { approvalCheck, gate, settledGate, type GateInput, type GateResult } from './gate.js';

const now = new Date('2026-01-07T15:00:00Z'); // Wednesday

function input(patch: Partial<GateInput> = {}): GateInput {
  return {
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
    approval: { rule: 'none', state: 'none' },
    ...patch,
  };
}

const base = input();

function reasonOf(out: GateResult): string | undefined {
  return 'reason' in out ? out.reason : undefined;
}

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
      {
        destination: {
          ...base.destination,
          live: false,
          instanceError: { code: 'secret_error', message: 'x' },
        },
      },
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
    ['approval always', { approval: { rule: 'always', state: 'none' } }, 'awaiting_approval'],
    [
      'approval expression true',
      { approval: { rule: 'events[0]', state: 'none', evaluated: { result: true } } },
      'awaiting_approval',
    ],
  ])('%s → held %s', (_name, patch, reason) => {
    const out = gate(input(patch), now);
    expect(out.pass).toBe(false);
    expect(reasonOf(out)).toBe(reason);
    expect(out.checks.at(-1)?.pass).toBe(false);
  });

  it('names the instance error when the destination has no live object', () => {
    const out = gate(
      input({
        destination: {
          ...base.destination,
          live: false,
          instanceError: { code: 'secret_error', message: 'provider "env" is not running' },
        },
      }),
      now,
    );
    expect(out.checks.at(-1)?.detail).toBe('secret_error: provider "env" is not running');
  });

  it('stops at the first failure: a disabled process is not also reported as quiet hours', () => {
    const out = gate(
      input({ process: { enabled: false }, quietHours: { start: '00:00', end: '23:59' } }),
      now,
    );
    expect(reasonOf(out)).toBe('process_disabled');
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

  it('an open breaker says when the cooldown closes it, or that only a reset does', () => {
    const openedAt = new Date(now.getTime() - 60_000);
    const cooling = gate(input({ breaker: { state: 'open', openedAt, cooldownMinutes: 60 } }), now);
    expect(cooling.checks.at(-1)?.detail).toBe('closes at 2026-01-07T15:59:00.000Z');
    const manual = gate(input({ breaker: { state: 'open', openedAt, cooldownMinutes: 0 } }), now);
    expect(reasonOf(manual)).toBe('breaker_open');
    expect(manual.checks.at(-1)?.detail).toBe('reset by hand');
  });
});

describe('approval: evaluated lazily, last', () => {
  const expression = { rule: 'events[0].attributes.risky', state: 'none' as const };

  it('asks for the expression only once every earlier check has passed', () => {
    const out = gate(input({ approval: expression }), now);
    expect(out).toMatchObject({ pass: false, evaluateApproval: true });
    expect(out.checks.map((c) => c.check)).not.toContain('approval');
    expect(out.checks.every((c) => c.pass)).toBe(true);
  });

  it.each<[string, Partial<GateInput>]>([
    ['process disabled', { process: { enabled: false } }],
    ['destination disabled', { destination: { ...base.destination, enabled: false } }],
    ['breaker open', { breaker: { state: 'open', openedAt: now, cooldownMinutes: 60 } }],
    ['quiet hours', { quietHours: { start: '14:00', end: '16:00' } }],
  ])('an earlier hold (%s) never asks for it', (_name, patch) => {
    const out = gate(input({ ...patch, approval: expression }), now);
    expect('evaluateApproval' in out).toBe(false);
    expect(out.pass).toBe(false);
  });

  it.each<[string, GateInput['approval'], boolean]>([
    ['none passes', { rule: 'none', state: 'none' }, true],
    ['always holds', { rule: 'always', state: 'none' }, false],
    ['always passes once approved', { rule: 'always', state: 'approved' }, true],
    ['expression false passes', { ...expression, evaluated: { result: false } }, true],
    [
      'expression error holds (fail closed)',
      { ...expression, evaluated: { result: false, error: 'syntax' } },
      false,
    ],
    ['an approved expression needs no evaluation', { ...expression, state: 'approved' }, true],
  ])('%s', (_name, approval, pass) => {
    expect(gate(input({ approval }), now).pass).toBe(pass);
  });

  it('a dry run skips the approval gate but not the others', () => {
    expect(
      gate(input({ dryRun: true, approval: { rule: 'always', state: 'none' } }), now).pass,
    ).toBe(true);
    expect(gate(input({ dryRun: true, approval: expression }), now).pass).toBe(true);
    expect(gate(input({ dryRun: true, process: { enabled: false } }), now).pass).toBe(false);
  });

  it.each([
    ['none', false, 'none', undefined, 'pass'],
    ['always', false, 'none', undefined, 'hold'],
    ['size > 1', false, 'none', undefined, 'evaluate'],
    ['size > 1', true, 'none', undefined, 'pass'],
    ['size > 1', false, 'approved', undefined, 'pass'],
    ['size > 1', false, 'pending', { result: true }, 'hold'],
    ['size > 1', false, 'pending', { result: false }, 'pass'],
    ['size > 1', false, 'none', { result: false, error: 'boom' }, 'hold'],
  ] as const)(
    'approvalCheck(%s, dry run %s, %s, %j) → %s',
    (rule, dryRun, approvalState, evaluated, outcome) => {
      expect(approvalCheck(rule, { dryRun, approvalState }, evaluated).outcome).toBe(outcome);
    },
  );

  it('settledGate holds a result still waiting on the expression for a person', () => {
    const out = settledGate(gate(input({ approval: expression }), now));
    expect(out).toMatchObject({ pass: false, reason: 'awaiting_approval' });
  });
});
