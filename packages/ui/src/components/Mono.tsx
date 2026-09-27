import type { ReactNode } from 'react';

/** Inline monospace text for ids, expressions and counts. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={['mono', className].filter(Boolean).join(' ')}>{children}</span>;
}
