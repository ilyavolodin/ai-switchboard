import { useCallback, useState } from 'react';

import { usedByOf } from '../../api/client.js';

/** A process named by a "still used by" refusal. */
export interface ProcessRef {
  id: string;
  name: string;
}

/**
 * State for a delete the API refuses while processes still use the instance (409 with
 * `usedBy`). Pass `onError` to `useReasonedMutation` (it swallows that toast), render
 * `<InUseBanner>` while `usedBy` is set; `block(list)` shows it without asking the server when
 * the caller already knows the processes.
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
