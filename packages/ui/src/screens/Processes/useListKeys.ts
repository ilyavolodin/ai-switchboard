import { useState } from 'react';

let counter = 0;
const fresh = () => `item-${++counter}`;

/**
 * React keys for a list whose items carry no id (steps, notifications), so removing one item does
 * not hand its editor state to the next. A length change from outside (discard, reload) pads or
 * trims the tail.
 */
export function useListKeys(length: number) {
  const [keys, setKeys] = useState(() => Array.from({ length }, fresh));
  if (keys.length !== length) {
    setKeys(
      keys.length > length
        ? keys.slice(0, length)
        : [...keys, ...Array.from({ length: length - keys.length }, fresh)],
    );
  }
  return {
    keys,
    added: () => {
      setKeys((k) => [...k, fresh()]);
    },
    removed: (index: number) => {
      setKeys((k) => k.filter((_, j) => j !== index));
    },
  };
}
