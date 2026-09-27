import type { ArtifactRef } from '@ai-switchboard/core/contract';

/** The display id: GitHub numbers get a `#` (`#482`), everything else as-is (`LOL-1712`). */
export function artifactLabel(a: ArtifactRef): string {
  if (a.kind.startsWith('github.') && /^\d+$/.test(a.id)) return `#${a.id}`;
  return a.id;
}

/** "Linear" for `linear.issue`. */
export function artifactSystem(kind: string): string {
  const system = kind.split('.')[0] ?? kind;
  return system.charAt(0).toUpperCase() + system.slice(1);
}

/** The in-app trace route for an artifact id or query. */
export function traceHref(query: string): string {
  return `/activity/trace/${encodeURIComponent(query)}`;
}
