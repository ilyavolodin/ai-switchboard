import { useCallback, useState } from 'react';

import type { SectionId } from './editorModel.js';

export function useOpenSections(initial: SectionId[]) {
  const [open, setOpen] = useState<Set<SectionId>>(() => new Set(initial));
  const toggle = useCallback((s: SectionId) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);
  const openAll = useCallback((list: (SectionId | null)[]) => {
    setOpen((prev) => new Set([...prev, ...list.filter((s): s is SectionId => s != null)]));
  }, []);
  return { isOpen: (s: SectionId) => open.has(s), toggle, openAll };
}
