import { describe, expect, it } from 'vitest';

import { instanceStatus, processStatus, runStatusLabel } from '../../domain/labels.js';
import { RUN_STATUSES } from '../../domain/status.js';
import { indicatorFor, safeHeaders } from './activity.js';
import { dotsFrom, nextSweepAt } from './processes.js';
import { defaultProcessDocument } from '../../domain/process.js';

const dispatch = (over: Partial<Parameters<typeof indicatorFor>[1][number]> = {}) => ({
  processId: 'p',
  processName: 'P',
  outcome: 'batched',
  batchOutcome: null,
  batchReason: null,
  runId: null,
  runStatus: null,
  ...over,
});

describe('status vocabulary', () => {
  it('maps every run status to a tone and a label', () => {
    for (const s of RUN_STATUSES) {
      const label = runStatusLabel(s);
      expect(['ok', 'warn', 'error', 'off']).toContain(label.tone);
      expect(label.label).not.toBe('');
    }
    expect(runStatusLabel('uncertain').tone).toBe('warn');
    expect(runStatusLabel('failed').tone).toBe('error');
  });

  it('orders instance status: plugin > disabled > secrets > health > soft-hold > stale', () => {
    const base = { enabled: true, health: null, instanceError: undefined };
    expect(
      instanceStatus({
        ...base,
        instanceError: { code: 'plugin_unavailable', message: '' },
        enabled: false,
      }),
    ).toEqual({ tone: 'warn', label: 'plugin unavailable' });
    expect(instanceStatus({ ...base, enabled: false })).toEqual({ tone: 'off', label: 'disabled' });
    expect(
      instanceStatus({ ...base, instanceError: { code: 'secret_error', message: 'x' } }).label,
    ).toBe('secret error');
    expect(
      instanceStatus({ ...base, instanceError: { code: 'create_failed', message: 'x' } }).label,
    ).toBe('failed to start');
    expect(
      instanceStatus({ ...base, health: { status: 'unhealthy', checkedAt: '' }, softHold: true })
        .label,
    ).toBe('unhealthy');
    expect(instanceStatus({ ...base, softHold: true, stale: true }).label).toBe('soft-hold');
    expect(instanceStatus({ ...base, stale: true }).tone).toBe('warn');
    expect(instanceStatus({ ...base, health: { status: 'healthy', checkedAt: '' } })).toEqual({
      tone: 'ok',
      label: 'healthy',
    });
  });

  it('puts an open breaker above everything for a process', () => {
    expect(
      processStatus({ enabled: false, breakerOpen: true, awaitingApproval: 1, lastRunStatus: 'ok' })
        .label,
    ).toBe('breaker open');
    expect(
      processStatus({ enabled: true, breakerOpen: false, awaitingApproval: 2, lastRunStatus: 'ok' })
        .tone,
    ).toBe('warn');
    expect(
      processStatus({
        enabled: true,
        breakerOpen: false,
        awaitingApproval: 0,
        lastRunStatus: null,
      }),
    ).toEqual({ tone: 'off', label: 'not yet run' });
    expect(
      processStatus({ enabled: true, breakerOpen: false, awaitingApproval: 0, lastRunStatus: 'ok' })
        .label,
    ).toBe('flowing');
  });
});

describe('stage indicator', () => {
  it('stops at the door for events no process wanted', () => {
    expect(indicatorFor('unmatched', [])).toMatchObject({ reached: 1, tone: 'off' });
    expect(indicatorFor('event_invalid', [])).toMatchObject({ reached: 1, tone: 'error' });
  });

  it('shows the furthest-reaching dispatch', () => {
    expect(
      indicatorFor('matched', [
        dispatch({ outcome: 'deduped' }),
        dispatch({ batchOutcome: 'throttled', batchReason: 'meter:five_hour' }),
      ]),
    ).toEqual({
      reached: 3,
      tone: 'warn',
      label: 'throttled · meter:five_hour',
    });
    expect(
      indicatorFor('matched', [
        dispatch({ batchOutcome: 'invoked', runId: 'r', runStatus: 'error' }),
      ]),
    ).toMatchObject({ reached: 5, tone: 'error' });
    expect(
      indicatorFor('matched', [dispatch({ batchOutcome: 'invoked', runId: 'r', runStatus: 'ok' })]),
    ).toMatchObject({ reached: 5, tone: 'ok' });
  });
});

describe('pipeline dots', () => {
  it('colours the gated stop amber when anything was held or throttled', () => {
    const d = dotsFrom({
      matched: 5,
      batched: 4,
      passed: 1,
      stopped: 2,
      invoked: 1,
      ok: 0,
      bad: 1,
    });
    expect(d.tones).toEqual(['ok', 'ok', 'warn', 'ok', 'error']);
    expect(
      dotsFrom({ matched: 0, batched: 0, passed: 0, stopped: 0, invoked: 0, ok: 0, bad: 0 }).tones,
    ).toEqual(['off', 'off', 'off', 'off', 'off']);
  });

  it('computes the next sweep in the schedule timezone and skips invalid crons', () => {
    const doc = defaultProcessDocument('p', 'e');
    doc.schedules = [
      { id: 'a', cron: '0 7 * * *', timezone: 'Europe/London', catchUp: 'skip', enabled: true },
      { id: 'b', cron: 'not a cron', timezone: 'UTC', catchUp: 'skip', enabled: true },
      { id: 'c', cron: '0 6 * * *', timezone: 'UTC', catchUp: 'skip', enabled: false },
    ];
    // 2026-07-01 is BST (UTC+1): 07:00 London = 06:00Z.
    expect(nextSweepAt(doc, new Date('2026-07-01T05:00:00Z'))?.toISOString()).toBe(
      '2026-07-01T06:00:00.000Z',
    );
    doc.schedules = [];
    expect(nextSweepAt(doc, new Date())).toBeNull();
  });
});

describe('raw delivery headers', () => {
  it('drops every header that can carry a credential', () => {
    const kept = safeHeaders({
      'content-type': 'application/json',
      'user-agent': 'GitHub-Hookshot/abc',
      'x-github-event': 'pull_request',
      authorization: 'Bearer fixture-secret',
      'proxy-authorization': 'Basic fixture',
      cookie: 'a=b',
      'x-hub-signature-256': 'sha256=abc',
      'x-api-key': 'fixture-secret',
      'dd-api-key': 'fixture-secret',
      'x-auth-password': 'fixture-secret',
      'x-webhook-secret': 'fixture-secret',
      'x-slack-request-token': 'fixture-secret',
      'x-amz-security-token': 'fixture-secret',
      'x-credentials': 'fixture-secret',
    });
    expect(Object.keys(kept).sort()).toEqual(['content-type', 'user-agent', 'x-github-event']);
  });
});
