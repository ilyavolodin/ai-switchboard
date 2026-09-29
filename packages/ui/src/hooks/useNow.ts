import { useEffect, useState } from 'react';

import { now } from '../lib/clock.js';

/** Relative times and countdowns read time through this so render stays pure and they tick. */
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
