import type { BoardDestinationNode } from '@ai-switchboard/core/contract';

import { MeterGauge } from './MeterGauge.js';
import { NodeCard } from './NodeCard.js';

export interface DestinationNodeProps {
  destination: Pick<
    BoardDestinationNode,
    'id' | 'name' | 'typeName' | 'status' | 'enabled' | 'meters' | 'softHoldUntil'
  >;
  href?: string;
  width?: number;
  dimmed?: boolean;
  highlighted?: boolean;
  describedBy?: string;
  /** Draw only this process's ceilings on the arcs (the editor). */
  processId?: string;
}

/** A destination on the canvas: name, type and its meters as small arcs. */
export function DestinationNode({
  destination,
  href,
  width = 220,
  dimmed,
  highlighted,
  processId,
  describedBy,
}: DestinationNodeProps) {
  return (
    <NodeCard
      tone={destination.status.tone}
      title={destination.name}
      meta={destination.softHoldUntil ? 'soft hold' : destination.typeName}
      href={href}
      ariaLabel={`Destination ${destination.name}, ${destination.status.label}`}
      width={width}
      dimmed={dimmed}
      highlighted={highlighted}
      describedBy={describedBy}
    >
      <span className="visually-hidden">{destination.status.label}</span>
      <span style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 52 }}>
        {destination.meters.length === 0 ? (
          <span style={{ fontSize: 12 }}>no meters</span>
        ) : (
          destination.meters
            .slice(0, 4)
            .map((m) => (
              <MeterGauge
                key={m.meterId}
                meter={m}
                size="node"
                label="compact"
                processId={processId}
              />
            ))
        )}
      </span>
    </NodeCard>
  );
}
