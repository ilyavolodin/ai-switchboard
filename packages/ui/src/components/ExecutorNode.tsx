import type { BoardExecutorNode } from '@ai-switchboard/core/contract';

import { MeterGauge } from './MeterGauge.js';
import { NodeCard } from './NodeCard.js';

export interface ExecutorNodeProps {
  executor: Pick<
    BoardExecutorNode,
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

/** An executor instance on the canvas: name, type and its meters as small arcs. */
export function ExecutorNode({
  executor,
  href,
  width = 220,
  dimmed,
  highlighted,
  processId,
  describedBy,
}: ExecutorNodeProps) {
  return (
    <NodeCard
      tone={executor.status.tone}
      title={executor.name}
      meta={executor.softHoldUntil ? 'soft hold' : executor.typeName}
      href={href}
      ariaLabel={`Executor ${executor.name}, ${executor.status.label}`}
      width={width}
      dimmed={dimmed}
      highlighted={highlighted}
      describedBy={describedBy}
    >
      <span className="visually-hidden">{executor.status.label}</span>
      <span style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 52 }}>
        {executor.meters.length === 0 ? (
          <span style={{ fontSize: 12 }}>no meters</span>
        ) : (
          executor.meters
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
