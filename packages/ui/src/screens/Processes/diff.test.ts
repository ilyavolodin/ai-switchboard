import { describe, expect, it } from 'vitest';

import {
  changeLabel,
  describeChange,
  diffValues,
  documentChanges,
  formatChangeValue,
} from './diff.js';

describe('diffValues', () => {
  it.each([
    ['equal scalars', 1, 1, []],
    ['a changed scalar', 1, 2, [{ path: [], before: 1, after: 2 }]],
    [
      'a nested field',
      { a: { b: 1 } },
      { a: { b: 2 } },
      [{ path: ['a', 'b'], before: 1, after: 2 }],
    ],
    ['an added key', { a: 1 }, { a: 1, b: 2 }, [{ path: ['b'], before: undefined, after: 2 }]],
    ['an appended item', [1], [1, 2], [{ path: [1], before: undefined, after: 2 }]],
    ['undefined on both sides', { a: undefined }, {}, []],
  ])('%s', (_name, before, after, expected) => {
    expect(diffValues(before, after)).toEqual(expected);
  });
});

describe('documentChanges', () => {
  it('reads a list of event types as one change', () => {
    const changes = documentChanges(
      { triggers: [{ eventTypes: ['a'] }] },
      { triggers: [{ eventTypes: ['a', 'b', 'c'] }] },
    );
    expect(changes).toEqual([
      { path: ['triggers', 0, 'eventTypes'], before: ['a'], after: ['a', 'b', 'c'] },
    ]);
  });
});

describe('changeLabel', () => {
  it.each([
    [['name'], 'name'],
    [['batching', 'debounceSeconds'], 'debounce'],
    [['triggers', 0, 'eventTypes'], 'trigger 1 event types'],
    [['budgets', 'usagePerDay', 'input_tokens'], 'input_tokens per day'],
    [['budgets', 'meterCeilings', 'weekly', 'events'], 'ceiling weekly events'],
    [[], 'document'],
  ])('%j reads as %s', (path, label) => {
    expect(changeLabel(path)).toBe(label);
  });
});

describe('formatChangeValue', () => {
  it.each([
    [undefined, '—'],
    ['', '—'],
    [true, 'true'],
    [3, '3'],
    ['x'.repeat(50), `${'x'.repeat(39)}…`],
    [{ a: 1 }, '{"a":1}'],
  ])('%j → %s', (value, text) => {
    expect(formatChangeValue(value)).toBe(text);
  });

  it('describes a change as label, before and after', () => {
    expect(describeChange({ path: ['batching', 'maxSize'], before: 20, after: 5 })).toBe(
      'max size 20 → 5',
    );
  });
});
