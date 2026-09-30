import { describe, expect, it } from 'vitest';

import { defaultProcessDocument, type ProcessDocument } from '../domain/process.js';
import type { EventStage } from '../domain/status.js';

import { explainEvent, summarizeWhy, type ExplainInput, type ExplainProcess } from './explain.js';

const T0 = new Date('2026-09-01T10:00:00Z');

function proc(
  id: string,
  patch: Partial<ProcessDocument> = {},
  enabled = true,
  createdAt = new Date('2026-08-01T00:00:00Z'),
): ExplainProcess {
  return {
    id,
    name: `Process ${id}`,
    enabled,
    createdAt,
    document: { ...defaultProcessDocument(id, 'x1'), enabled, ...patch },
  };
}

const trigger = (id: string, eventTypes: string[], extra = {}) => ({
  id,
  sourceId: 's1',
  eventTypes,
  describe: `When ${id}`,
  enabled: true,
  ...extra,
});

function input(stage: EventStage, patch: Partial<ExplainInput> = {}): ExplainInput {
  return {
    event: { sourceId: 's1', type: 'gh.pr.labeled', stage, stageReason: null, receivedAt: T0 },
    decisions: [],
    dispatches: [],
    processes: [],
    ...patch,
  };
}

describe('explainEvent', () => {
  it('says nothing while the event waits for match', () => {
    expect(explainEvent(input('received', { processes: [proc('p1')] }))).toEqual([]);
  });

  it('explains every recorded reason from the match stage', () => {
    const processes = [
      proc('a', { triggers: [trigger('t', ['*'])] }, false),
      proc('b', { triggers: [trigger('t', ['*'], { enabled: false })] }),
      proc('c', { triggers: [trigger('t', ['gh.pr.opened', 'gh.issue.*'])] }),
      proc('d', { triggers: [trigger('t', ['*'], { filter: 'x = 1' })] }),
      proc('e', { triggers: [trigger('t', ['*'], { filter: 'bad(' })] }),
      proc('f', { triggers: [trigger('t', ['*'])] }),
    ];
    const out = explainEvent(
      input('matched', {
        processes,
        decisions: [
          { processId: 'a', triggerId: 't', result: false, skip: 'process_disabled' },
          { processId: 'b', triggerId: 't', result: false, skip: 'trigger_disabled' },
          { processId: 'c', triggerId: 't', result: false, skip: 'type_not_subscribed' },
          { processId: 'd', triggerId: 't', result: false, expr: 'x = 1' },
          { processId: 'e', triggerId: 't', result: false, expr: 'bad(', error: 'syntax' },
          { processId: 'f', triggerId: 't', result: true },
        ],
      }),
    );
    expect(out.map((x) => [x.processId, x.taken, x.reason, x.basis])).toEqual([
      ['f', true, 'trigger "When t" matched', 'recorded'],
      ['a', false, 'process is disabled', 'recorded'],
      ['b', false, 'trigger "When t" is disabled', 'recorded'],
      [
        'c',
        false,
        'event type gh.pr.labeled is not in trigger "When t" (subscribes to gh.pr.opened, gh.issue.*)',
        'recorded',
      ],
      ['d', false, 'filter false: x = 1', 'recorded'],
      ['e', false, 'filter error: syntax', 'recorded'],
    ]);
  });

  it('says a match was deduped', () => {
    const [x] = explainEvent(
      input('matched', {
        processes: [proc('p', { triggers: [trigger('t', ['*'])] })],
        decisions: [{ processId: 'p', triggerId: 't', result: true }],
        dispatches: [{ processId: 'p', outcome: 'deduped' }],
      }),
    );
    expect(x?.reason).toMatch(/deduped/);
    expect(x?.taken).toBe(true);
  });

  it.each([
    ['source_disabled', null, 'source is disabled'],
    ['type_muted', null, 'type gh.pr.labeled is muted on the source'],
    ['event_invalid', 'artifact.id is empty', 'event invalid: artifact.id is empty'],
  ] as const)('door stage %s applies to every process on the source', (stage, why, reason) => {
    const out = explainEvent(
      input(stage, {
        event: { sourceId: 's1', type: 'gh.pr.labeled', stage, stageReason: why, receivedAt: T0 },
        processes: [proc('p', { triggers: [trigger('t', ['*'])] }), proc('q')],
      }),
    );
    expect(out).toEqual([
      expect.objectContaining({ processId: 'p', taken: false, reason, basis: 'recorded' }),
    ]);
  });

  it('falls back to the current configuration when nothing was recorded, labelled now', () => {
    const out = explainEvent(
      input('unmatched', {
        processes: [
          proc('old', { triggers: [trigger('t', ['*'])] }, false),
          proc(
            'later',
            { triggers: [trigger('t', ['*'])] },
            false,
            new Date('2026-09-02T00:00:00Z'),
          ),
        ],
      }),
    );
    expect(out).toEqual([
      expect.objectContaining({ processId: 'old', reason: 'process is disabled', basis: 'now' }),
    ]);
  });
});

describe('summarizeWhy', () => {
  const x = (processName: string, tone: 'ok' | 'warn' | 'off', reason: string, taken = false) => ({
    processId: processName,
    processName,
    taken,
    reason,
    basis: 'recorded' as const,
    tone,
  });

  it('leads with the most actionable reason for an unmatched event', () => {
    expect(
      summarizeWhy('unmatched', [
        x('A', 'off', 'filter false: y'),
        x('B', 'warn', 'process is disabled'),
      ]),
    ).toBe('B: process is disabled (+1 more)');
    expect(summarizeWhy('unmatched', [])).toBe('no process has a trigger on this source');
  });

  it('says nothing when something took the event or it stopped at the door', () => {
    expect(summarizeWhy('matched', [x('A', 'ok', 'matched', true)])).toBeNull();
    expect(summarizeWhy('type_muted', [x('A', 'off', 'muted')])).toBeNull();
  });
});
