import type { BoardResponse } from '@ai-switchboard/core/contract';

import type { FlowNodeType } from '../../components/FlowNode.js';
import type { BoardFlowEdge } from './BoardEdge.js';
import { keyFacts, nodeHref } from './facts.js';
import type { BoardLayout, LaidOutEdge } from './layout.js';

export interface Size {
  width: number;
  height: number;
}

export function neighboursOf(edges: LaidOutEdge[], id: string | null): Set<string> | null {
  if (!id) return null;
  const set = new Set<string>([id]);
  for (const e of edges) {
    if (e.source === id) set.add(e.target);
    if (e.target === id) set.add(e.source);
  }
  return set;
}

export function disabledCount(data: BoardResponse): number {
  return [...data.sources, ...data.processes, ...data.destinations].filter((x) => !x.enabled)
    .length;
}

export function edgeAriaLabel(e: LaidOutEdge): string {
  return e.kind === 'trigger'
    ? `Trigger ${e.source} to ${e.target}: ${e.eventTypes.join(', ')}, ${e.volume24h} events in 24 h`
    : `Binding ${e.source} to ${e.target}, ${e.volume24h} runs in 24 h`;
}

export interface FlowNodeState {
  hovered: string | null;
  measured: Record<string, Size>;
  nowMs: number;
  onHover: (id: string | null) => void;
}

export function toFlowNodes(layout: BoardLayout, state: FlowNodeState): FlowNodeType[] {
  const neighbours = neighboursOf(layout.edges, state.hovered);
  return layout.nodes.map((n) => {
    const common = {
      href: nodeHref(n),
      width: n.width,
      facts: keyFacts(n, state.nowMs),
      highlighted: state.hovered === n.id,
      dimmed: neighbours != null && !neighbours.has(n.id),
      onHover: state.onHover,
    };
    const data =
      n.kind === 'source'
        ? { kind: n.kind, source: n.node, ...common }
        : n.kind === 'process'
          ? { kind: n.kind, process: n.node, nowMs: state.nowMs, ...common }
          : { kind: n.kind, destination: n.node, ...common };
    const measured = state.measured[n.id];
    return {
      id: n.id,
      type: 'switchboard',
      position: { x: n.x, y: n.y },
      data,
      draggable: false,
      connectable: false,
      selectable: false,
      zIndex: state.hovered === n.id ? 10 : 1,
      width: n.width,
      ...(measured ? { measured } : {}),
    };
  });
}

export function toFlowEdges(
  layout: BoardLayout,
  hovered: string | null,
  focused: boolean,
): BoardFlowEdge[] {
  return layout.edges.map((e) => {
    const touches = hovered != null && (e.source === hovered || e.target === hovered);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'switchboard',
      focusable: false,
      selectable: false,
      ariaLabel: edgeAriaLabel(e),
      data: {
        width: e.width,
        dashed: e.dashed,
        live: e.live,
        enabled: e.enabled,
        label: e.label,
        showLabel: touches || (focused && e.kind === 'trigger'),
        dimmed: hovered != null && !touches,
      },
    };
  });
}

/** Returns `prev` itself when nothing changed, so the state update is a no-op. */
export function mergeDimensions(
  prev: Record<string, Size>,
  changes: { id: string; dimensions: Size }[],
): Record<string, Size> {
  let next = prev;
  for (const c of changes) {
    const old = prev[c.id];
    if (old?.width === c.dimensions.width && old.height === c.dimensions.height) continue;
    if (next === prev) next = { ...prev };
    next[c.id] = { width: c.dimensions.width, height: c.dimensions.height };
  }
  return next;
}
