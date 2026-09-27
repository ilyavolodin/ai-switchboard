import { traceHref } from '../lib/artifact.js';

/**
 * Where the top-bar search goes. Every query is treated as an artifact id (`LOL-1712`, `#482`,
 * `github.pr:482`, a run id) and opens the Activity trace for it.
 */
export function searchTarget(query: string): string | null {
  const q = query.trim();
  if (!q) return null;
  return traceHref(q);
}
