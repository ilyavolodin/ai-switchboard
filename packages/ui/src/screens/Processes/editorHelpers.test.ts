import { describe, expect, it } from 'vitest';

import { ApiRequestError } from '../../api/client.js';
import {
  approvalLabel,
  approvalMode,
  classifySaveError,
  newProcessDocument,
  newTrigger,
  problemSections,
  removeAt,
  replaceAt,
  setOptionalKey,
  stepProviders,
  updateAt,
} from './editorModel.js';
import { draftReducer, initialDraft } from './processDraft.js';

describe('classifySaveError', () => {
  it.each([
    [
      'a version conflict',
      new ApiRequestError(409, { error: 'conflict', message: 'stale' }),
      'conflict',
    ],
    [
      'a refusal naming fields',
      new ApiRequestError(422, { error: 'invalid', message: 'bad', details: ['/name is blank'] }),
      'invalid',
    ],
    ['a refusal with no details', new ApiRequestError(400, { error: 'x', message: 'no' }), 'other'],
    ['a network error', new Error('offline'), 'other'],
  ])('%s', (_name, error, kind) => {
    expect(classifySaveError(error).kind).toBe(kind);
  });

  it('places the named fields on their sections', () => {
    const f = classifySaveError(
      new ApiRequestError(422, { error: 'invalid', message: 'bad', details: ['/name is blank'] }),
    );
    expect(f).toEqual({
      kind: 'invalid',
      message: 'bad',
      placed: [{ pointer: '/name', message: 'is blank', section: 'basics' }],
    });
  });
});

describe('stepProviders', () => {
  it('lists each triggered source once, then the destination', () => {
    const doc = newProcessDocument('dest-1');
    const trigger = newTrigger([]);
    doc.triggers = [
      { ...trigger, id: 't1', sourceId: 's1' },
      { ...trigger, id: 't2', sourceId: 's1' },
      { ...trigger, id: 't3', sourceId: '' },
    ];
    expect(stepProviders(doc, (id) => (id === 's1' ? 'Linear' : ''), undefined)).toEqual([
      { id: 's1', name: 'Linear', kind: 'source' },
      { id: 'dest-1', name: 'dest-1', kind: 'destination' },
    ]);
  });
});

describe('list and key helpers', () => {
  it('updates, replaces and removes by index', () => {
    const list = [{ a: 1 }, { a: 2 }];
    expect(updateAt(list, 1, { a: 5 })).toEqual([{ a: 1 }, { a: 5 }]);
    expect(replaceAt(list, 0, { a: 9 })).toEqual([{ a: 9 }, { a: 2 }]);
    expect(removeAt(list, 0)).toEqual([{ a: 2 }]);
  });

  it('drops a cleared optional key', () => {
    const b: { runsPerDay?: number; runsPerHour?: number } = { runsPerDay: 3, runsPerHour: 1 };
    expect(setOptionalKey(b, 'runsPerDay', undefined)).toEqual({ runsPerHour: 1 });
    expect('runsPerDay' in setOptionalKey(b, 'runsPerDay', undefined)).toBe(false);
    expect(setOptionalKey(b, 'runsPerDay', 7)).toEqual({ runsPerDay: 7, runsPerHour: 1 });
  });

  it('maps problem pointers to their sections', () => {
    expect(problemSections({ '/name': 'x', '/triggers/0/sourceId': 'y' })).toEqual([
      'basics',
      'triggers',
    ]);
  });
});

describe('approval mode', () => {
  it.each([
    ['none', 'none', 'none'],
    ['always', 'always', 'always'],
    ['$count(events) > 5', 'expression', 'by expression'],
  ])('%s', (approval, mode, label) => {
    expect(approvalMode(approval)).toBe(mode);
    expect(approvalLabel(approval)).toBe(label);
  });
});

describe('draftReducer', () => {
  const doc = newProcessDocument('d');
  const rename = (name: string) => ({
    type: 'edit' as const,
    update: (d: typeof doc) => ({ ...d, name }),
  });

  it('edits the draft and discards back to the baseline', () => {
    const edited = draftReducer(initialDraft(doc, 3), rename('New'));
    expect(edited.draft.name).toBe('New');
    expect(edited.baseline.name).toBe(doc.name);
    expect(draftReducer(edited, { type: 'discard' }).draft).toBe(doc);
  });

  it('makes the saved draft the baseline', () => {
    const saving = draftReducer(draftReducer(initialDraft(doc, 3), rename('New')), {
      type: 'saveStarted',
    });
    expect(saving.saving).toBe(true);
    const saved = draftReducer(saving, { type: 'saved' });
    expect(saved.saving).toBe(false);
    expect(saved.baseline.name).toBe('New');
  });

  it.each([
    [{ kind: 'conflict' as const }, { conflict: true, saveError: null }],
    [
      { kind: 'other' as const, message: 'offline' },
      { conflict: false, saveError: 'offline' },
    ],
    [
      { kind: 'invalid' as const, message: 'bad', placed: [] },
      { conflict: false, saveError: 'bad' },
    ],
  ])('records a failed save: %j', (failure, expected) => {
    const s = draftReducer(
      { ...initialDraft(doc, 1), saving: true },
      { type: 'saveFailed', failure },
    );
    expect(s).toMatchObject({ ...expected, saving: false });
  });

  it('loads the stored version or keeps the draft on a newer base version', () => {
    const stored = { ...doc, name: 'Theirs' };
    const conflicted = { ...draftReducer(initialDraft(doc, 1), rename('Mine')), conflict: true };
    const loaded = draftReducer(conflicted, { type: 'loadStored', document: stored, version: 4 });
    expect(loaded).toMatchObject({
      draft: stored,
      baseline: stored,
      baseVersion: 4,
      conflict: false,
    });
    const kept = draftReducer(conflicted, { type: 'keepMine', version: 4 });
    expect(kept).toMatchObject({ baseVersion: 4, conflict: false });
    expect(kept.draft.name).toBe('Mine');
  });
});
