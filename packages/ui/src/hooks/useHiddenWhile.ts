import { useCallback, useState } from 'react';

/** Hides a dialog while `work` runs (a reason prompt must not stack on it), keeping its state. */
export function useHiddenWhile() {
  const [hidden, setHidden] = useState(false);
  const run = useCallback(async <T>(work: () => Promise<T>): Promise<T> => {
    setHidden(true);
    try {
      return await work();
    } finally {
      setHidden(false);
    }
  }, []);
  return { hidden, run };
}
