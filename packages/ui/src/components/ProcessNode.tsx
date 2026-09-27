import type { BoardProcessNode } from '@ai-switchboard/core/contract';

import { useNow } from '../hooks/useNow.js';
import { formatWhen, toMs } from '../lib/format.js';
import { NodeCard } from './NodeCard.js';
import { PipelineDots } from './PipelineDots.js';

export interface ProcessNodeProps {
  process: Pick<
    BoardProcessNode,
    | 'id'
    | 'name'
    | 'status'
    | 'enabled'
    | 'awaitingApproval'
    | 'dots'
    | 'nextSweepAt'
    | 'breakerOpen'
  >;
  href?: string;
  width?: number;
  dimmed?: boolean;
  highlighted?: boolean;
  describedBy?: string;
}

/** A process on the canvas: name, the five pipeline dots for the last hour, and its next sweep. */
export function ProcessNode({
  process,
  href,
  width = 240,
  dimmed,
  highlighted,
  describedBy,
}: ProcessNodeProps) {
  const nowMs = useNow(60_000);
  const next = toMs(process.nextSweepAt);
  const sweep = !process.enabled
    ? 'disabled'
    : next != null
      ? `sweep ${formatWhen(next, nowMs)}`
      : 'no sweep';
  const meta = process.awaitingApproval > 0 ? `${process.awaitingApproval} awaiting` : undefined;
  return (
    <NodeCard
      tone={process.status.tone}
      title={process.name}
      meta={meta}
      href={href}
      ariaLabel={`Process ${process.name}, ${process.status.label}, ${sweep}`}
      width={width}
      dimmed={dimmed}
      highlighted={highlighted}
      describedBy={describedBy}
    >
      <PipelineDots dots={process.dots} />
      <span className="visually-hidden">{process.status.label}</span>
      <span style={{ flexGrow: 1 }} />
      <span>{sweep}</span>
    </NodeCard>
  );
}
