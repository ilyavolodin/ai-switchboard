import { useEffect, useRef } from 'react';

import { isModalOpen } from '../hooks/useModal.js';

/**
 * The single place for keyboard bindings. `/` focuses search; `g` then a letter navigates.
 * Bindings are ignored while typing in a field and while a dialog or drawer is open (it is modal).
 */
export const SHORTCUTS = [
  { keys: '/', label: 'search', action: 'search' },
  { keys: 'g b', label: 'board', action: 'navigate', to: '/' },
  { keys: 'g p', label: 'processes', action: 'navigate', to: '/processes' },
  { keys: 'g a', label: 'activity', action: 'navigate', to: '/activity' },
] as const;

/** How long after `g` the second key counts. */
const SEQUENCE_MS = 1200;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
  }
  return false;
}

/** Installs the global bindings on `document`. */
export function useGlobalShortcuts(handlers: {
  onSearch: () => void;
  onNavigate: (to: string) => void;
}): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (isModalOpen()) return;
      if (e.key === '/') {
        e.preventDefault();
        ref.current.onSearch();
        pendingG = 0;
        return;
      }
      const key = e.key.toLowerCase();
      if (pendingG && Date.now() - pendingG <= SEQUENCE_MS) {
        const binding = SHORTCUTS.find((s) => s.keys === `g ${key}`);
        pendingG = 0;
        if (binding?.action === 'navigate') {
          e.preventDefault();
          ref.current.onNavigate(binding.to);
        }
        return;
      }
      pendingG = key === 'g' ? Date.now() : 0;
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);
}
