import type { BoardSourceNode } from '@ai-switchboard/core/contract';

import { formatCount } from '../lib/format.js';
import styles from './NodeCard.module.css';
import { NodeCard } from './NodeCard.js';
import { ToneDot } from './ToneDot.js';

export interface SourceNodeProps {
  source: Pick<BoardSourceNode, 'id' | 'name' | 'typeName' | 'status' | 'enabled' | 'events24h'>;
  href?: string;
  width?: number;
  dimmed?: boolean;
  highlighted?: boolean;
  describedBy?: string;
  /** Replaces the body line. */
  detail?: string;
}

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
          <ToneDot tone={tone} />
          <span>{label}</span>
          <span className={styles.grow} />
          <span>
            <span className="mono">{formatCount(source.events24h)}</span> / 24 h
          </span>
        </>
      )}
    </NodeCard>
  );
}
