import { useState } from 'react';

import { sameValue } from '../lib/values.js';

/**
 * A form draft over saved settings. A refetch (another tab's save) replaces a clean draft and
 * keeps unsaved edits.
 */
export function useSettingsDraft<D extends object>(saved: D) {
  const [base, setBase] = useState(saved);
  const [draft, setDraft] = useState(saved);
  if (!sameValue(base, saved)) {
    setBase(saved);
    if (sameValue(draft, base)) setDraft(saved);
  }
  return {
    draft,
    set: (patch: Partial<D>) => {
      setDraft((d) => ({ ...d, ...patch }));
    },
    discard: () => {
      setDraft(base);
    },
  };
}
