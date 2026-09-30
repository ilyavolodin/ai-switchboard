import { useCallback, useState } from 'react';

import { usedByOf } from '../api/client.js';

export interface ProcessRef {
  id: string;
  name: string;
}

/**
 * Pass `onError` to `useReasonedMutation` (it swallows that toast) and render `<InUseBanner>` while
 * `usedBy` is set; `block(list)` shows it without asking the server.
 */
export function useInUseRefusal() {
  const [usedBy, setUsedBy] = useState<ProcessRef[] | null>(null);
  const onError = useCallback((e: unknown) => {
    const used = usedByOf(e);
    if (!used) return false;
    setUsedBy(used);
    return true;
  }, []);
  const dismiss = useCallback(() => {
    setUsedBy(null);
  }, []);
  return { usedBy, block: setUsedBy, onError, dismiss };
}
