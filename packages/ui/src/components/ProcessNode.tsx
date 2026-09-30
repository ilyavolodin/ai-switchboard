import type { BoardProcessNode } from '@ai-switchboard/core/contract';

import { formatWhen, toMs } from '../lib/format.js';
import styles from './NodeCard.module.css';
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
  /** The board's clock, so every node reads the same time without its own timer. */
  nowMs: number;
}

export function ProcessNode({
  process,
  href,
  width = 240,
  dimmed,
  highlighted,
  describedBy,
  nowMs,
}: ProcessNodeProps) {
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
      <span className={styles.grow} />
      <span>{sweep}</span>
    </NodeCard>
  );
}
