import { useState } from 'react';

/**
 * For an on/off switch over a group of values: switching off and on again in one visit restores
 * the values it had, and otherwise the saved values when they were on.
 */
export function useRestorableSwitch<T>(current: T, baseline: T, isOn: (value: T) => boolean) {
  const [previous, setPrevious] = useState<T | undefined>(undefined);
  return (next: boolean): T | undefined => {
    if (!next) setPrevious(current);
    return previous ?? (isOn(baseline) ? baseline : undefined);
  };
}
