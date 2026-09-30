import { useState } from 'react';

import { sameValue } from '../lib/values.js';

export interface SettingsDraftOptions<S, D> {
  /** The editable part of what was saved; the draft and its baseline have this shape. */
  project?: (saved: S) => D;
  /** Default: the draft differs from the baseline, ignoring key order and `undefined` keys. */
  isDirty?: (draft: D, base: D) => boolean;
  /**
   * A refetch that arrives while the draft is dirty leaves the baseline alone too, so changed
   * markers and Discard keep using the values the edits started from.
   */
  keepBaseWhileDirty?: boolean;
  /** Called whenever the draft is replaced wholesale: a clean refetch, Discard or `reset`. */
  onAdopt?: (next: D) => void;
}

export interface SettingsDraft<S, D> {
  draft: D;
  /** What the draft is compared against. */
  base: D;
  dirty: boolean;
  set: (patch: Partial<D>) => void;
  discard: () => void;
  /** After a save: the server normalises what it stores, so both draft and baseline come from its response. */
  reset: (next: S) => void;
}

/**
 * A form draft over saved settings. A refetch (another tab's save) replaces a clean draft and
 * keeps unsaved edits.
 */
export function useSettingsDraft<D extends object>(
  saved: D,
  options?: SettingsDraftOptions<D, D>,
): SettingsDraft<D, D>;
export function useSettingsDraft<S, D extends object>(
  saved: S,
  options: SettingsDraftOptions<S, D> & { project: (saved: S) => D },
): SettingsDraft<S, D>;
export function useSettingsDraft<S, D extends object>(
  saved: S,
  {
    project = (s) => s as unknown as D,
    isDirty = (draft, base) => !sameValue(draft, base),
    keepBaseWhileDirty = false,
    onAdopt,
  }: SettingsDraftOptions<S, D> = {},
): SettingsDraft<S, D> {
  const [seen, setSeen] = useState(saved);
  const [base, setBase] = useState(() => project(saved));
  const [draft, setDraft] = useState(base);
  const dirty = isDirty(draft, base);
  const adopt = (next: D) => {
    setBase(next);
    setDraft(next);
    onAdopt?.(next);
  };
  if (!sameValue(seen, saved)) {
    setSeen(saved);
    const next = project(saved);
    if (!dirty) adopt(next);
    else if (!keepBaseWhileDirty) setBase(next);
  }
  return {
    draft,
    base,
    dirty,
    set: (patch) => {
      setDraft((d) => ({ ...d, ...patch }));
    },
    discard: () => {
      adopt(base);
    },
    reset: (next) => {
      adopt(project(next));
    },
  };
}
