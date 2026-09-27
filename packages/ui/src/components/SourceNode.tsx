import type { BoardSourceNode } from '@ai-switchboard/core/contract';

import { formatCount } from '../lib/format.js';
import { toneVars } from '../lib/tone.js';
import { NodeCard } from './NodeCard.js';

export interface SourceNodeProps {
  source: Pick<BoardSourceNode, 'id' | 'name' | 'typeName' | 'status' | 'enabled' | 'events24h'>;
  href?: string;
  width?: number;
  dimmed?: boolean;
  highlighted?: boolean;
  describedBy?: string;
  /** Replaces the body line (the editor shows the subscribed event types). */
  detail?: string;
}

/** A source instance on the canvas: name, type, status word and events in the last 24 h. */
export function SourceNode({
  source,
  href,
  width = 200,
  dimmed,
  highlighted,
  detail,
  describedBy,
}: SourceNodeProps) {
  const { tone, label } = source.status;
  return (
    <NodeCard
      tone={tone}
      title={source.name}
      meta={source.typeName}
      href={href}
      ariaLabel={`Source ${source.name}, ${label}, ${source.events24h} events in 24 h`}
      width={width}
      dimmed={dimmed}
      highlighted={highlighted}
      describedBy={describedBy}
    >
      {detail ?? (
        <>
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: toneVars(tone).fill,
              flexShrink: 0,
            }}
          />
          <span>{label}</span>
          <span style={{ flexGrow: 1 }} />
          <span>
            <span className="mono">{formatCount(source.events24h)}</span> / 24 h
          </span>
        </>
      )}
    </NodeCard>
  );
}
