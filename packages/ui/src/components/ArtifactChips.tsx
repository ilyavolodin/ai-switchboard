import type { ArtifactRef } from '@ai-switchboard/core/contract';

import { traceHref } from '../lib/hrefs.js';
import { ArtifactChip } from './ArtifactChip.js';

/** One chip per artifact; `trace` links each to its Activity trace. Renders bare chips (no wrapper). */
export function ArtifactChips({
  artifacts,
  trace = false,
  limit,
  showIcon,
}: {
  artifacts: readonly ArtifactRef[];
  trace?: boolean;
  limit?: number;
  showIcon?: boolean;
}) {
  const shown = limit === undefined ? artifacts : artifacts.slice(0, limit);
  return (
    <>
      {shown.map((a) => (
        <ArtifactChip
          key={`${a.kind}:${a.id}`}
          artifact={a}
          {...(trace ? { to: traceHref(a.id) } : {})}
          {...(showIcon === undefined ? {} : { showIcon })}
        />
      ))}
    </>
  );
}
