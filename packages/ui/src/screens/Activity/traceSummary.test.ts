import type { TraceEntry } from '@ai-switchboard/core/contract';
import { describe, expect, it } from 'vitest';

import { summarizeTrace, traceStage } from './traceSummary.js';

const at = '2026-03-02T10:00:00Z';
const e = (over: Partial<TraceEntry>): TraceEntry => ({
  at,
  kind: 'event',
  tone: 'ok',
  title: 'x',
  ...over,
});

describe('summarizeTrace', () => {
  it('counts events and runs and colours a process by its last outcome', () => {
    const s = summarizeTrace([
      e({ kind: 'event', eventId: 'e1' }),
      e({ kind: 'batch_join', eventId: 'e2', processId: 'p1', processName: 'Autofix' }),
      e({ kind: 'invoke', processId: 'p1', runId: 'r1' }),
      e({ kind: 'terminal', runId: 'r1', tone: 'error' }),
    ]);
    expect(s).toEqual({
      events: 2,
      runs: 1,
      ok: 0,
      errors: 1,
      processes: [{ id: 'p1', name: 'Autofix', tone: 'error' }],
    });
  });

  it('leaves out a process that did not take the event', () => {
    const s = summarizeTrace([
      e({ kind: 'event', eventId: 'e1' }),
      e({ kind: 'filter', processId: 'p2', data: { taken: false }, tone: 'off' }),
    ]);
    expect(s.processes).toEqual([]);
  });
});

describe('traceStage', () => {
  it.each([
    [[], 0, 'nothing recorded'],
    [[e({ kind: 'event' })], 1, 'x'],
    [[e({ kind: 'event' }), e({ kind: 'gate', tone: 'warn', title: 'Held' })], 3, 'held'],
    [[e({ kind: 'event' }), e({ kind: 'terminal', title: 'Run ok' })], 5, 'run ok'],
  ])('stops at the right place (%#)', (entries, reached, label) => {
    const s = traceStage(entries);
    expect(s.reached).toBe(reached);
    expect(s.label).toBe(label);
  });
});
