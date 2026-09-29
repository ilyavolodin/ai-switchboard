import type { BoardResponse } from '@ai-switchboard/core/contract';
import {
  Controls,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import { useMemo, useState } from 'react';

import { useBoard } from '../../api/index.js';
import { Card } from '../../components/Card.js';
import { FilterChips } from '../../components/FilterChips.js';
import { FlowNode } from '../../components/FlowNode.js';
import { PipelineDots } from '../../components/PipelineDots.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Time } from '../../components/Time.js';
import { QueryError } from '../../components/QueryError.js';
import { useNow } from '../../hooks/useNow.js';
import { useSearchParamState } from '../../hooks/useSearchParamState.js';
import { AttentionPanel } from './AttentionPanel.js';
import styles from './Board.module.css';
import { BoardEdge } from './BoardEdge.js';
import { BoardEmpty } from './BoardEmpty.js';
import { disabledCount, toFlowEdges, toFlowNodes } from './boardFlow.js';
import { FitView } from './FitView.js';
import { COLUMNS, layoutBoard } from './layout.js';
import { useMeasuredNodes } from './useMeasuredNodes.js';

type ColumnLabelNode = Node<{ label: string }, 'column'>;

function ColumnLabel({ data }: NodeProps<ColumnLabelNode>) {
  return <span className={styles.columnLabel}>{data.label}</span>;
}

const nodeTypes: NodeTypes = { switchboard: FlowNode, column: ColumnLabel };

const COLUMN_LABELS: ColumnLabelNode[] = (
  [
    ['source', 'sources'],
    ['process', 'processes'],
    ['destination', 'destinations'],
  ] as const
).map(([kind, label]) => ({
  id: `column:${kind}`,
  type: 'column',
  position: { x: COLUMNS[kind].x, y: -34 },
  data: { label },
  draggable: false,
  selectable: false,
  focusable: false,
}));
const edgeTypes: EdgeTypes = { switchboard: BoardEdge };

const LEGEND_DOTS = {
  matched: 0,
  batched: 0,
  gated: 0,
  invoked: 0,
  ok: 0,
  tones: ['ok', 'ok', 'warn', 'off', 'off'],
} as const satisfies Parameters<typeof PipelineDots>[0]['dots'];

export function Board() {
  const board = useBoard();

  return (
    <>
      <div className={styles.header}>
        <h1 className="t-screen-title">Board</h1>
        <span className="t-caption">what feeds what · last 24 h</span>
        {board.data && (
          <span className="t-caption">
            · updated <Time value={board.data.generatedAt} />
          </span>
        )}
      </div>
      {board.isPending ? (
        <div className={styles.grid}>
          <Skeleton shape="card" height={480} label="Loading the board" />
          <Skeleton shape="card" height={280} />
        </div>
      ) : board.isError ? (
        <QueryError query={board} title="The board could not load" />
      ) : board.data.processes.length === 0 ? (
        <div className={styles.grid}>
          <BoardEmpty
            sources={board.data.sources.length}
            destinations={board.data.destinations.length}
          />
          <AttentionPanel items={board.data.attention} />
        </div>
      ) : (
        <BoardCanvas data={board.data} />
      )}
    </>
  );
}

function BoardCanvas({ data }: { data: BoardResponse }) {
  const [hide, setHide] = useSearchParamState('hide');
  const [focus, setFocus] = useSearchParamState('focus');
  const nowMs = useNow(60_000);
  const [hovered, setHovered] = useState<string | null>(null);
  const { measured, onNodesChange } = useMeasuredNodes();
  const hideDisabled = hide === 'disabled';
  const focusProcess = data.processes.find((p) => p.id === focus) ?? null;

  const layout = useMemo(
    () => layoutBoard(data, { hideDisabled, focusProcessId: focusProcess?.id ?? null }),
    [data, hideDisabled, focusProcess?.id],
  );
  const nodes = toFlowNodes(layout, { hovered, measured, nowMs, onHover: setHovered });
  const edges = toFlowEdges(layout, hovered, focusProcess != null);

  const view = hideDisabled ? 'hide-disabled' : 'all';
  const canvasHeight = Math.max(360, layout.height + 80);

  return (
    <>
      <div className={styles.filters}>
        <SegmentedControl
          label="Show"
          value={view}
          options={[
            { value: 'all', label: 'All' },
            {
              value: 'hide-disabled',
              label: 'Hide disabled',
              count: disabledCount(data),
            },
          ]}
          onChange={(v) => {
            setHide(v === 'hide-disabled' ? 'disabled' : null);
          }}
        />
        <Select
          size="sm"
          aria-label="Focus one process"
          className={styles.focusSelect}
          placeholder="Focus a process…"
          options={data.processes.map((p) => ({ value: p.id, label: p.name }))}
          value={focusProcess?.id ?? ''}
          onChange={(e) => {
            setFocus(e.target.value || null);
          }}
        />
        {focusProcess && (
          <FilterChips
            label="Active focus"
            removable
            chips={[{ value: focusProcess.id, label: `${focusProcess.name} only` }]}
            selected={[focusProcess.id]}
            onToggle={() => {
              setFocus(null);
            }}
          />
        )}
      </div>
      <div className={`${styles.grid} ${styles.fill}`}>
        <Card className={styles.canvasCard} padding="flush" aria-label="Board canvas">
          <div className={styles.legend} aria-hidden="true">
            <span className={styles.legendKey}>
              <span className={styles.legendLine} />
              edge width = volume 24 h
            </span>
            <span className={styles.legendKey}>
              <span className={styles.legendDot} />
              live flow, last minutes
            </span>
            <span className={styles.legendKey}>
              <span className={styles.legendDashed} />
              quiet
            </span>
            <span className={styles.legendKey}>
              <PipelineDots dots={LEGEND_DOTS} size="sm" />
              last hour: matched › batched › gated › invoked › ok
            </span>
          </div>
          <div className={styles.canvas} style={{ minHeight: canvasHeight }}>
            <ReactFlowProvider>
              <ReactFlow
                nodes={[...COLUMN_LABELS, ...nodes]}
                onNodesChange={onNodesChange}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                edgesFocusable={false}
                zoomOnScroll={false}
                panOnScroll={false}
                preventScrolling={false}
                zoomOnDoubleClick={false}
                minZoom={0.35}
                maxZoom={1.5}
                fitView
                fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
                aria-label="Sources, processes and destinations"
                proOptions={{ hideAttribution: true }}
                // Passing node mouse handlers is what makes React Flow give nodes pointer events
                // (it sets pointer-events: none inline on nodes that are not draggable, selectable
                // or connectable). Without them nothing on the canvas can be hovered or clicked.
                onNodeMouseEnter={(_, node) => {
                  if (node.type === 'switchboard') setHovered(node.id);
                }}
                onNodeMouseLeave={() => {
                  setHovered(null);
                }}
              >
                <Controls showInteractive={false} position="bottom-right" />
                <FitView layoutKey={layout.nodes.map((n) => n.id).join(',')} />
              </ReactFlow>
            </ReactFlowProvider>
          </div>
        </Card>
        <AttentionPanel items={data.attention} />
      </div>
    </>
  );
}
