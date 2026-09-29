import { useState } from 'react';

import { useLeaveGuard } from './useLeaveGuard.js';

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A form draft over saved settings. A refetch (another tab's save) replaces a clean draft and
 * keeps unsaved edits; leaving with unsaved edits asks first.
 */
export function useSettingsDraft<D extends object>(saved: D, same = sameJson) {
  const [base, setBase] = useState(saved);
  const [draft, setDraft] = useState(saved);
  if (!same(base, saved)) {
    setBase(saved);
    if (same(draft, base)) setDraft(saved);
  }
  const dirty = !same(draft, base);
  const leaveGuard = useLeaveGuard(dirty);
  return {
    draft,
    dirty,
    leaveGuard,
    set: (patch: Partial<D>) => {
      setDraft((d) => ({ ...d, ...patch }));
    },
    discard: () => {
      setDraft(base);
    },
  };
}
