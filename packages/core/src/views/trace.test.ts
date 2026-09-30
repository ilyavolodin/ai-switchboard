import { describe, expect, it } from 'vitest';

import { renderTraceText, runTone, traceEntries, type TraceData } from './trace.js';

const t = (s: string) => new Date(`2026-03-02T10:00:${s}Z`);

function data(over: Partial<TraceData>): TraceData {
  return {
    events: [],
    dispatches: [],
    batches: [],
    runs: [],
    updates: [],
    steps: [],
    approvals: [],
    notifications: [],
    processNames: new Map([['p1', 'Autofix']]),
    destinationNames: new Map([['d1', 'Routines']]),
    explanations: new Map(),
    ...over,
  };
}

type RunRow = TraceData['runs'][number];

const run = (over: Partial<RunRow>): RunRow =>
  ({
    id: 'r1',
    batchId: 'b1',
    processId: 'p1',
    destinationId: 'd1',
    status: 'ok',
    statusReason: null,
    dryRun: false,
    attempts: 1,
    input: {},
    externalId: null,
    externalUrl: null,
    usage: null,
    errors: null,
    invokedAt: t('01'),
    finishedAt: t('05'),
    ...over,
  }) as RunRow;

describe('traceEntries', () => {
  it('shows an invoke and a terminal state for a run with no logged updates', () => {
    const entries = traceEntries(data({ runs: [run({})] }));
    expect(entries.map((e) => [e.kind, e.title, e.processName])).toEqual([
      ['invoke', 'Invoked Routines', 'Autofix'],
      ['terminal', 'Run ok', 'Autofix'],
    ]);
  });

  it('shows no invoke for a run nothing was sent for', () => {
    const entries = traceEntries(
      data({ runs: [run({ status: 'failed', attempts: 0, statusReason: 'input_invalid' })] }),
    );
    expect(entries.map((e) => e.kind)).toEqual(['terminal']);
  });

  it('orders by time, then by pipeline stage', () => {
    const entries = traceEntries(
      data({
        batches: [
          {
            id: 'b1',
            processId: 'p1',
            kind: 'event',
            decisions: [
              { stage: 'budget', check: 'budget', pass: true, at: t('01').toISOString() },
              { stage: 'gate', check: 'enabled', pass: true, at: t('01').toISOString() },
            ],
          } as unknown as TraceData['batches'][number],
        ],
      }),
    );
    expect(entries.map((e) => e.kind)).toEqual(['gate', 'budget']);
    expect(renderTraceText('#1', entries).split('\n')[0]).toBe('Trace for #1');
  });
});

describe('runTone', () => {
  it.each([
    ['ok', 'ok'],
    ['running', 'ok'],
    ['failed', 'error'],
    ['uncertain', 'warn'],
  ] as const)('%s is %s', (status, tone) => {
    expect(runTone(status)).toBe(tone);
  });
});
