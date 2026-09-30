import { describe, expect, it } from 'vitest';

import {
  BATCHING_DEFAULTS,
  BATCHING_OFF,
  batchingOn,
  batchingSummary,
  budgetsOn,
  budgetsSummary,
  checkDocument,
  collectErrors,
  errorsUnder,
  newProcessDocument,
  newTrigger,
  placeErrors,
  saveConsequence,
  withBatching,
  withBudgets,
} from './editorModel.js';

describe('collectErrors', () => {
  it('places client checks and server details on their sections; client wins a pointer', () => {
    const server = placeErrors([
      '/name must not be blank',
      '/budgets/runsPerHour must be >= 0',
      'document is too large',
    ]);
    const out = collectErrors({ '/name': 'A process needs a name' }, server);
    expect(out.byPointer).toEqual({
      '/name': 'A process needs a name',
      '/budgets/runsPerHour': 'must be >= 0',
    });
    expect(out.bySection.budgets).toEqual(['/budgets/runsPerHour must be >= 0']);
    expect(out.bySection.basics).toEqual(['A process needs a name', '/name must not be blank']);
    expect(out.general.map((e) => e.message)).toEqual(['document is too large']);
  });
});

describe('checkDocument', () => {
  it('checks the core schema and words the common problems for the editor', () => {
    const doc = {
      ...newProcessDocument(''),
      name: '  ',
      triggers: [
        { ...newTrigger([]), id: 't1' },
        { ...newTrigger([]), id: 't2', sourceId: 'src-linear' },
      ],
      batching: { debounceSeconds: 90_000, maxSize: 20, maxAgeSeconds: 600 },
    };
    expect(checkDocument(doc)).toEqual({
      '/name': 'A process needs a name',
      '/triggers/0/sourceId': 'Pick a source',
      '/triggers/1/eventTypes': 'Tick at least one event type',
      '/destination/instanceId': 'Pick a destination',
      '/batching/debounceSeconds': expect.any(String),
    });
  });

  it('passes a complete document', () => {
    expect(checkDocument({ ...newProcessDocument('ex-http'), name: 'Triage' })).toEqual({});
  });
});

describe('errorsUnder', () => {
  it('keeps one list item’s errors, relative to it, and not a sibling with a longer index', () => {
    const errors = {
      '/triggers/1/sourceId': 'Pick a source',
      '/triggers/10/eventTypes': 'Tick one',
      '/name': 'x',
    };
    expect(errorsUnder(errors, '/triggers/1')).toEqual({ '/sourceId': 'Pick a source' });
  });
});

describe('saveConsequence', () => {
  it('lists up to three changes and the version a save writes', () => {
    expect(
      saveConsequence({
        isNew: false,
        enabled: true,
        changes: ['a', 'b', 'c', 'd'],
        baseVersion: 4,
      }),
    ).toBe('4 changes: a; b; c; …. Saving writes version 5.');
    expect(saveConsequence({ isNew: false, enabled: true, changes: ['a'], baseVersion: 1 })).toBe(
      '1 change: a. Saving writes version 2.',
    );
  });

  it('says whether a new process starts enabled', () => {
    expect(saveConsequence({ isNew: true, enabled: false, changes: [], baseVersion: 0 })).toMatch(
      /created disabled/,
    );
  });
});

describe('batching switch', () => {
  const doc = newProcessDocument('ex');
  it('derives off from max size 1 and summarises it', () => {
    expect(batchingOn(BATCHING_DEFAULTS)).toBe(true);
    expect(batchingOn({ debounceSeconds: 30, maxSize: 1, maxAgeSeconds: 600 })).toBe(false);
    expect(batchingSummary(BATCHING_OFF)).toBe('Off — one run per event');
    expect(batchingSummary(BATCHING_DEFAULTS)).toBe('debounce 30 s · max 20 · max age 10 min');
  });

  it('off writes 0 / 1 / 0 without a group-by; on restores what batched, else defaults', () => {
    const grouped = {
      ...doc,
      batching: { ...BATCHING_DEFAULTS, maxSize: 5, groupBy: 'artifact.id' },
    };
    expect(withBatching(grouped, false).batching).toEqual({
      debounceSeconds: 0,
      maxSize: 1,
      maxAgeSeconds: 0,
    });
    expect(withBatching(doc, true, grouped.batching).batching).toEqual(grouped.batching);
    expect(withBatching(doc, true, BATCHING_OFF).batching).toEqual(BATCHING_DEFAULTS);
    expect(withBatching(doc, true).batching).toEqual(BATCHING_DEFAULTS);
  });
});

describe('budgets switch', () => {
  const doc = newProcessDocument('ex');
  it('is on when any cap or ceiling is set', () => {
    expect(budgetsOn({ meterCeilings: {} })).toBe(false);
    expect(budgetsOn({ runsPerHour: 0, meterCeilings: {} })).toBe(true);
    expect(budgetsOn({ usagePerDay: { tokens: 1 }, meterCeilings: {} })).toBe(true);
    expect(budgetsOn({ meterCeilings: { m: { events: 80, sweeps: 95 } } })).toBe(true);
    expect(budgetsSummary({ meterCeilings: {} })).toBe('No limits');
  });

  it('off clears every cap; on restores the previous caps, else 20 runs per day', () => {
    const capped = { ...doc, budgets: { runsPerHour: 2, meterCeilings: {} } };
    expect(withBudgets(capped, false).budgets).toEqual({ meterCeilings: {} });
    expect(withBudgets(doc, true, capped.budgets).budgets).toEqual(capped.budgets);
    expect(withBudgets(doc, true, { meterCeilings: {} }).budgets).toEqual({
      runsPerDay: 20,
      meterCeilings: {},
    });
  });
});
