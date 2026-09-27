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
import { useSearchParams } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { useBoard } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { FilterChips } from '../../components/FilterChips.js';
import { FlowNode, type FlowNodeType } from '../../components/FlowNode.js';
import { PipelineDots } from '../../components/PipelineDots.js';
import { SegmentedControl } from '../../components/SegmentedControl.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Time } from '../../components/Time.js';
import { useNow } from '../../hooks/useNow.js';
import { AttentionPanel } from './AttentionPanel.js';
import styles from './Board.module.css';
import { BoardEdge, type BoardFlowEdge } from './BoardEdge.js';
import { BoardEmpty } from './BoardEmpty.js';
import { keyFacts, nodeHref } from './facts.js';
import { FitView } from './FitView.js';
import { COLUMNS, layoutBoard } from './layout.js';

type ColumnLabelNode = Node<{ label: string }, 'column'>;

/** A column heading drawn in the canvas so it pans and zooms with the nodes. */
function ColumnLabel({ data }: NodeProps<ColumnLabelNode>) {
  return <span className={styles.columnLabel}>{data.label}</span>;
}

const nodeTypes: NodeTypes = { switchboard: FlowNode, column: ColumnLabel };

const COLUMN_LABELS: ColumnLabelNode[] = (
  [
    ['source', 'sources'],
    ['process', 'processes'],
    ['executor', 'executors'],
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

/**
 * The Board: the system's picture. Sources → processes → executors on a React Flow canvas
 * (edge width = 24 h volume, animated dots = live flow, border = status), a filter row (hide
 * disabled, focus one process), and the "Needs attention" panel with one-click actions.
 * Polls `GET /board` every 10 s.
 */
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
        <Banner
          tone="error"
          title="The board could not load"
          actions={
            <Button size="sm" variant="outline" onClick={() => void board.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(board.error)}
        </Banner>
      ) : board.data.processes.length === 0 ? (
        <div className={styles.grid}>
          <BoardEmpty sources={board.data.sources.length} executors={board.data.executors.length} />
          <AttentionPanel items={board.data.attention} />
        </div>
      ) : (
        <BoardCanvas data={board.data} />
      )}
    </>
  );
}

function BoardCanvas({ data }: { data: BoardResponse }) {
  const [params, setParams] = useSearchParams();
  const nowMs = useNow(60_000);
  const [hovered, setHovered] = useState<string | null>(null);
  const hideDisabled = params.get('hide') === 'disabled';
  const focus = params.get('focus');
  const focusProcess = data.processes.find((p) => p.id === focus) ?? null;

  const layout = useMemo(
    () => layoutBoard(data, { hideDisabled, focusProcessId: focusProcess?.id ?? null }),
    [data, hideDisabled, focusProcess?.id],
  );

  const neighbours = useMemo(() => {
    if (!hovered) return null;
    const set = new Set<string>([hovered]);
    for (const e of layout.edges) {
      if (e.source === hovered) set.add(e.target);
      if (e.target === hovered) set.add(e.source);
    }
    return set;
  }, [hovered, layout.edges]);

  const nodes: FlowNodeType[] = layout.nodes.map((n) => {
    const common = {
      href: nodeHref(n),
      width: n.width,
      facts: keyFacts(n, nowMs),
      highlighted: hovered === n.id,
      dimmed: neighbours != null && !neighbours.has(n.id),
      onHover: setHovered,
    };
    const data =
      n.kind === 'source'
        ? { kind: 'source' as const, source: n.node as BoardResponse['sources'][number], ...common }
        : n.kind === 'process'
          ? {
              kind: 'process' as const,
              process: n.node as BoardResponse['processes'][number],
              ...common,
            }
          : {
              kind: 'executor' as const,
              executor: n.node as BoardResponse['executors'][number],
              ...common,
            };
    return {
      id: n.id,
      type: 'switchboard',
      position: { x: n.x, y: n.y },
      data,
      draggable: false,
      connectable: false,
      selectable: false,
      zIndex: hovered === n.id ? 10 : 1,
      width: n.width,
    };
  });

  const edges: BoardFlowEdge[] = layout.edges.map((e) => {
    const touches = hovered != null && (e.source === hovered || e.target === hovered);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'switchboard',
      focusable: false,
      selectable: false,
      ariaLabel:
        e.kind === 'trigger'
          ? `Trigger ${e.source} to ${e.target}: ${e.eventTypes.join(', ')}, ${e.volume24h} events in 24 h`
          : `Binding ${e.source} to ${e.target}, ${e.volume24h} runs in 24 h`,
      data: {
        width: e.width,
        dashed: e.dashed,
        live: e.live,
        enabled: e.enabled,
        label: e.label,
        showLabel: touches || (focusProcess != null && e.kind === 'trigger'),
        dimmed: hovered != null && !touches,
      },
    };
  });

  const view = hideDisabled ? 'hide-disabled' : 'all';
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value == null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

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
              count:
                data.sources.filter((s) => !s.enabled).length +
                data.processes.filter((p) => !p.enabled).length +
                data.executors.filter((x) => !x.enabled).length,
            },
          ]}
          onChange={(v) => {
            setParam('hide', v === 'hide-disabled' ? 'disabled' : null);
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
            setParam('focus', e.target.value || null);
          }}
        />
        {focusProcess && (
          <FilterChips
            label="Active focus"
            removable
            chips={[{ value: focusProcess.id, label: `${focusProcess.name} only` }]}
            selected={[focusProcess.id]}
            onToggle={() => {
              setParam('focus', null);
            }}
          />
        )}
      </div>
      <div className={styles.grid}>
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
          <div className={styles.canvas} style={{ height: canvasHeight }}>
            <ReactFlowProvider>
              <ReactFlow
                nodes={[...COLUMN_LABELS, ...nodes]}
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
                aria-label="Sources, processes and executors"
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
