import type { ProcessDocument } from '@ai-switchboard/core/contract';

import type { PlacedError, SaveFailure } from './editorModel.js';

export interface DraftState {
  baseline: ProcessDocument;
  draft: ProcessDocument;
  baseVersion: number;
  clientErrors: Record<string, string>;
  serverErrors: PlacedError[];
  conflict: boolean;
  saveError: string | null;
  saving: boolean;
}

export type DraftAction =
  | { type: 'edit'; update: (doc: ProcessDocument) => ProcessDocument }
  | { type: 'discard' }
  | { type: 'checked'; problems: Record<string, string> }
  | { type: 'saveStarted' }
  | { type: 'saved' }
  | { type: 'saveFailed'; failure: SaveFailure }
  | { type: 'loadStored'; document: ProcessDocument; version: number }
  | { type: 'keepMine'; version: number };

export function initialDraft(doc: ProcessDocument, version: number): DraftState {
  return {
    baseline: doc,
    draft: doc,
    baseVersion: version,
    clientErrors: {},
    serverErrors: [],
    conflict: false,
    saveError: null,
    saving: false,
  };
}

const clean = { clientErrors: {}, serverErrors: [], saveError: null };

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case 'edit':
      return { ...state, draft: action.update(state.draft), saveError: null };
    case 'discard':
      return { ...state, ...clean, draft: state.baseline };
    case 'checked':
      return { ...state, clientErrors: action.problems };
    case 'saveStarted':
      return { ...state, saving: true, serverErrors: [], saveError: null };
    case 'saved':
      return { ...state, saving: false, baseline: state.draft };
    case 'saveFailed': {
      const f = action.failure;
      const done = { ...state, saving: false };
      if (f.kind === 'conflict') return { ...done, conflict: true };
      if (f.kind === 'invalid') return { ...done, serverErrors: f.placed, saveError: f.message };
      return { ...done, saveError: f.message };
    }
    case 'loadStored':
      return {
        ...initialDraft(action.document, action.version),
        saving: state.saving,
      };
    case 'keepMine':
      return { ...state, baseVersion: action.version, conflict: false };
  }
}
