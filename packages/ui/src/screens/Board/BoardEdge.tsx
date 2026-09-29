import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from '@xyflow/react';

import { useReducedMotion } from '../../hooks/useReducedMotion.js';
import styles from './Board.module.css';

export interface BoardEdgeData extends Record<string, unknown> {
  width: number;
  dashed: boolean;
  live: boolean;
  enabled: boolean;
  label: string;
  showLabel: boolean;
  dimmed: boolean;
}

export type BoardFlowEdge = Edge<BoardEdgeData, 'switchboard'>;

export function BoardEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<BoardFlowEdge>) {
  const reduced = useReducedMotion();
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const d = data ?? {
    width: 1.5,
    dashed: false,
    live: false,
    enabled: true,
    label: '',
    showLabel: false,
    dimmed: false,
  };
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: d.enabled ? 'var(--line-strong)' : 'var(--line)',
          strokeWidth: d.width,
          strokeDasharray: d.dashed ? '6 6' : undefined,
          opacity: d.dimmed ? 0.25 : 0.8,
        }}
      />
      {d.live && !reduced && !d.dimmed && (
        <circle r={3.5} fill="var(--tangerine)" data-part="flow-dot">
          <animateMotion dur="3s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      {d.showLabel && d.label && (
        <EdgeLabelRenderer>
          <div
            className={styles.edgeLabel}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
