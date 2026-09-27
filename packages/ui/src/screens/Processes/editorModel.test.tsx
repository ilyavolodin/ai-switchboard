import { describe, expect, it } from 'vitest';

import { collectErrors, errorsUnder, placeErrors, saveConsequence } from './editorModel.js';

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
