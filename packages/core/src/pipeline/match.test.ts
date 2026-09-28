import { describe, expect, it } from 'vitest';

import { defaultProcessDocument, type ProcessDocument } from '../domain/process.js';

import {
  candidateTriggers,
  decideMatches,
  eventStageAfterMatch,
  eventTypeMatches,
  skippedTriggers,
  type MatchableProcess,
} from './match.js';

function process(
  id: string,
  patch: Partial<ProcessDocument> = {},
  enabled = true,
): MatchableProcess {
  return {
    id,
    enabled,
    document: { ...defaultProcessDocument(id, 'x1'), enabled: true, ...patch },
  };
}

const trigger = (id: string, sourceId: string, eventTypes: string[], extra = {}) => ({
  id,
  sourceId,
  eventTypes,
  describe: '',
  enabled: true,
  ...extra,
});

describe('eventTypeMatches', () => {
  it.each([
    ['github.pr.labeled', 'github.pr.labeled', true],
    ['github.pr.*', 'github.pr.labeled', true],
    ['*', 'anything', true],
    ['github.pr.opened', 'github.pr.labeled', false],
    ['github.issue.*', 'github.pr.labeled', false],
  ])('%s vs %s → %s', (pattern, type, expected) => {
    expect(eventTypeMatches(pattern, type)).toBe(expected);
  });
});

describe('candidateTriggers', () => {
  const event = { sourceId: 's1', type: 'github.pr.labeled' };

  it('picks enabled triggers of enabled processes for the source and type', () => {
    const processes = [
      process('p1', { triggers: [trigger('t1', 's1', ['github.pr.labeled'], { filter: 'x' })] }),
      process('p2', { triggers: [trigger('t1', 's2', ['github.pr.labeled'])] }),
      process('p3', { triggers: [trigger('t1', 's1', ['github.pr.opened'])] }),
      process('p4', { triggers: [trigger('t1', 's1', ['*'], { enabled: false })] }),
      process('p5', { triggers: [trigger('t1', 's1', ['*'])] }, false),
      process('p7', {
        triggers: [trigger('a', 's1', ['github.pr.*']), trigger('b', 's1', ['github.pr.labeled'])],
      }),
    ];
    expect(candidateTriggers(event, processes)).toEqual([
      { processId: 'p1', triggerId: 't1', filter: 'x' },
      { processId: 'p7', triggerId: 'a' },
      { processId: 'p7', triggerId: 'b' },
    ]);
  });
});

describe('skippedTriggers', () => {
  const event = { sourceId: 's1', type: 'github.pr.labeled' };

  it('names why each trigger on the source was passed over', () => {
    const processes = [
      process('p1', { triggers: [trigger('t1', 's1', ['github.pr.labeled'])] }),
      process('p2', { triggers: [trigger('t1', 's2', ['*'])] }),
      process('p3', { triggers: [trigger('t1', 's1', ['github.pr.opened'])] }),
      process('p4', { triggers: [trigger('t1', 's1', ['*'], { enabled: false })] }),
      process(
        'p5',
        {
          triggers: [trigger('a', 's2', ['*']), trigger('b', 's1', ['*']), trigger('c', 's1', [])],
        },
        false,
      ),
    ];
    expect(skippedTriggers(event, processes)).toEqual([
      { processId: 'p3', triggerId: 't1', skip: 'type_not_subscribed' },
      { processId: 'p4', triggerId: 't1', skip: 'trigger_disabled' },
      { processId: 'p5', triggerId: 'b', skip: 'process_disabled' },
    ]);
  });
});

describe('decideMatches', () => {
  it('folds overlapping triggers into one decision per process', () => {
    const out = decideMatches([
      { processId: 'p1', triggerId: 'a', result: false },
      { processId: 'p1', triggerId: 'b', result: true },
      { processId: 'p1', triggerId: 'c', result: true },
      { processId: 'p2', triggerId: 'a', result: false, error: 'boom', filter: 'bad(' },
      { processId: 'p3', triggerId: 'a', result: false },
    ]);
    expect(out).toEqual([
      { processId: 'p1', triggerId: 'b', outcome: 'matched' },
      { processId: 'p2', triggerId: 'a', outcome: 'filter_error', filter: 'bad(', error: 'boom' },
      { processId: 'p3', triggerId: 'a', outcome: 'filtered' },
    ]);
    expect(eventStageAfterMatch(out)).toBe('matched');
    expect(eventStageAfterMatch(out.slice(1))).toBe('unmatched');
    expect(eventStageAfterMatch([])).toBe('unmatched');
  });

  it('a true filter wins over an erroring sibling trigger', () => {
    const out = decideMatches([
      { processId: 'p1', triggerId: 'a', result: false, error: 'x' },
      { processId: 'p1', triggerId: 'b', result: true },
    ]);
    expect(out).toEqual([{ processId: 'p1', triggerId: 'b', outcome: 'matched' }]);
  });
});
