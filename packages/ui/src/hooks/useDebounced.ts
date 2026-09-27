import { useEffect, useState } from 'react';

/** `value`, but only after it stopped changing for `delayMs` (live previews, search). */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(id);
    };
  }, [value, delayMs]);
  return debounced;
}
