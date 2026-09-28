import { type KeyboardEvent, useId, useState } from 'react';

import type { Suggestion } from '../lib/suggest.js';

/** What a control with a suggestion list needs: the list's state and its keyboard handling. */
export interface SuggestionsState {
  items: Suggestion[];
  active: number;
  listId: string;
  /** The active option's element id, for `aria-activedescendant`. */
  activeId: string | undefined;
  open: boolean;
  show: (items: Suggestion[]) => void;
  close: () => void;
  pick: (index: number) => void;
  /** Arrow keys move, Enter accepts, Escape (or Tab) closes. Returns true when it handled the key. */
  onKeyDown: (e: KeyboardEvent) => boolean;
  /** Props for the input or textarea the list belongs to. */
  inputProps: {
    'aria-autocomplete': 'list';
    'aria-controls': string | undefined;
    'aria-activedescendant': string | undefined;
    'data-suggestions-open': 'true' | undefined;
  };
}

/**
 * Keyboard-accessible suggestions for one control (no library): `show(items)` opens the list,
 * `onAccept` gets the chosen suggestion. The list closes on accept, Escape and `close()`.
 */
export function useSuggestions(onAccept: (s: Suggestion) => void): SuggestionsState {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();
  const open = items.length > 0;
  const close = () => {
    setItems([]);
  };
  const pick = (index: number) => {
    const chosen = items[index];
    close();
    if (chosen) onAccept(chosen);
  };
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open) return false;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => (a + 1) % items.length);
        return true;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => (a - 1 + items.length) % items.length);
        return true;
      case 'Enter':
        e.preventDefault();
        pick(active);
        return true;
      case 'Tab':
        // Tab keeps moving through the form; it never picks by surprise.
        close();
        return false;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        return true;
      default:
        return false;
    }
  };
  const activeId = open ? `${listId}-${String(Math.min(active, items.length - 1))}` : undefined;
  return {
    items,
    active: Math.min(active, Math.max(items.length - 1, 0)),
    listId,
    activeId,
    open,
    show: (next) => {
      setItems(next);
      setActive(0);
    },
    close,
    pick,
    onKeyDown,
    inputProps: {
      'aria-autocomplete': 'list',
      'aria-controls': open ? listId : undefined,
      'aria-activedescendant': activeId,
      'data-suggestions-open': open ? 'true' : undefined,
    },
  };
}
