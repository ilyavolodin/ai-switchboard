import { describe, expect, it } from 'vitest';

import { validateAgainst } from '@ai-switchboard/sdk';

import {
  approvalMode,
  defaultProcessDocument,
  processDocumentSchema,
  type ProcessDocument,
} from './process.js';

/** Every optional field set, so the schema and the interface can't drift apart unnoticed. */
const full: Required<ProcessDocument> = {
  name: 'Triage',
  description: 'Label new PRs',
  enabled: true,
  triggers: [
    {
      id: 't1',
      sourceId: 'src-1',
      eventTypes: ['github.pr.opened'],
      filter: "attributes.label = 'bug'",
      describe: 'a PR opens',
      enabled: true,
    },
  ],
  schedules: [
    { id: 's1', cron: '0 9 * * 1', timezone: 'Europe/Paris', catchUp: 'once', enabled: true },
  ],
  batching: { debounceSeconds: 30, maxSize: 20, maxAgeSeconds: 600, groupBy: 'artifact.id' },
  gates: {
    quietHours: { start: '22:00', end: '07:00', timezone: 'UTC', days: [1, 2, 3, 4, 5] },
    approval: 'batch.size > 5',
    breaker: { threshold: 3, cooldownMinutes: 60 },
  },
  budgets: {
    runsPerHour: 5,
    runsPerDay: 20,
    usagePerDay: { tokens: 1000 },
    meterCeilings: { quota: { events: 80, sweeps: 95 } },
  },
  destination: { instanceId: 'dst-1', target: { routine: 'r' } },
  input: '{ "runId": run.id }',
  before: [{ provider: 'src-1', action: 'comment', args: '{}', when: 'true' }],
  after: [{ provider: 'src-1', action: 'label', args: '{}' }],
  notify: [{ notifierId: 'n1', template: '"done"', on: ['ok', 'error', 'held', 'throttled'] }],
  trackingDeadlineMinutes: 120,
};

describe('processDocumentSchema', () => {
  it('accepts the default document', () => {
    expect(validateAgainst(processDocumentSchema, defaultProcessDocument('p', 'dst-1'))).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('accepts a document with every optional field set', () => {
    expect(validateAgainst(processDocumentSchema, full)).toEqual({ valid: true, errors: [] });
  });

  it('rejects a field the interface does not have', () => {
    expect(validateAgainst(processDocumentSchema, { ...full, extra: 1 }).valid).toBe(false);
  });

  it('rejects a quiet-hours time that is not HH:MM', () => {
    const doc = { ...full, gates: { ...full.gates, quietHours: { start: '7:00', end: '09:00' } } };
    expect(validateAgainst(processDocumentSchema, doc).valid).toBe(false);
  });
});

describe('approvalMode', () => {
  it.each([
    ['none', 'none'],
    ['always', 'always'],
    ['batch.size > 5', 'expression'],
  ] as const)('%s reads as %s', (rule, mode) => {
    expect(approvalMode(rule)).toBe(mode);
  });
});
