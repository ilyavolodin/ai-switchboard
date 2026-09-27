import { useEffect, useState } from 'react';

import { now } from '../lib/clock.js';

/**
 * The current time (epoch ms), re-rendering every `intervalMs`. Relative times and countdowns
 * read time through this hook so render stays pure and they tick on their own.
 */
export function useNow(intervalMs = 30_000): number {
  const [t, setT] = useState(now);
  useEffect(() => {
    const id = setInterval(() => {
      setT(now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return t;
}
