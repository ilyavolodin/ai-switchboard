import type {
  BoardDestinationNode,
  BoardProcessNode,
  BoardSourceNode,
} from '@ai-switchboard/core/contract';
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { useId, useState } from 'react';

import { cx } from '../lib/cx.js';
import { DestinationNode } from './DestinationNode.js';
import styles from './FlowNode.module.css';
import { ProcessNode } from './ProcessNode.js';
import { SourceNode } from './SourceNode.js';

export type FlowNodeData = (
  | { kind: 'source'; source: BoardSourceNode }
  | { kind: 'process'; process: BoardProcessNode; nowMs: number }
  | { kind: 'destination'; destination: BoardDestinationNode }
) & {
  href: string;
  width: number;
  facts?: string[];
  dimmed?: boolean;
  highlighted?: boolean;
  onHover?: (id: string | null) => void;
};

export type FlowNodeType = Node<FlowNodeData, 'switchboard'>;

/** Register as `nodeTypes={{ switchboard: FlowNode }}`. */
export function FlowNode({ id, data }: NodeProps<FlowNodeType>) {
  const [open, setOpen] = useState(false);
  const cardId = useId();
  const facts = data.facts ?? [];
  const set = (on: boolean) => () => {
    setOpen(on);
    data.onHover?.(on ? id : null);
  };
  const describedBy = facts.length ? cardId : undefined;
  const common = {
    href: data.href,
    width: data.width,
    dimmed: data.dimmed,
    highlighted: data.highlighted,
    describedBy,
  };
  const title =
    data.kind === 'source'
      ? data.source.name
      : data.kind === 'process'
        ? data.process.name
        : data.destination.name;
  return (
    <div
      className={styles.wrap}
      onMouseEnter={set(true)}
      onMouseLeave={set(false)}
      onFocus={set(true)}
      onBlur={set(false)}
    >
      {data.kind !== 'source' && (
        <Handle
          type="target"
          position={Position.Left}
          className={styles.handle}
          isConnectable={false}
        />
      )}
      {data.kind === 'source' && <SourceNode source={data.source} {...common} />}
      {data.kind === 'process' && (
        <ProcessNode process={data.process} nowMs={data.nowMs} {...common} />
      )}
      {data.kind === 'destination' && (
        <DestinationNode destination={data.destination} {...common} />
      )}
      {data.kind !== 'destination' && (
        <Handle
          type="source"
          position={Position.Right}
          className={styles.handle}
          isConnectable={false}
        />
      )}
      {facts.length > 0 && (
        <div id={cardId} role="tooltip" className={cx(styles.card, open && styles.open)}>
          <span className={styles.cardTitle}>{title}</span>
          {facts.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
      )}
    </div>
  );
}
