/**
 * Rows are ordered by the barycentre of their neighbours to reduce crossings. Pure, so it is stable
 * between polls.
 */
import type {
  BoardEdge,
  BoardDestinationNode,
  BoardProcessNode,
  BoardResponse,
  BoardSourceNode,
} from '@ai-switchboard/core/contract';

export const COLUMNS = {
  source: { x: 0, width: 200, row: 100 },
  process: { x: 300, width: 240, row: 72 },
  destination: { x: 600, width: 220, row: 150 },
} as const;

export type BoardNodeKind = keyof typeof COLUMNS;

export interface LaidOutNode {
  id: string;
  kind: BoardNodeKind;
  x: number;
  y: number;
  width: number;
  node: BoardSourceNode | BoardProcessNode | BoardDestinationNode;
}

export interface LaidOutEdge {
  id: string;
  kind: BoardEdge['kind'];
  source: string;
  target: string;
  /** Stroke width ∝ √(24 h volume / max volume of its kind), 1–4.5 px. */
  width: number;
  dashed: boolean;
  /** Something flowed in the last 5 minutes. */
  live: boolean;
  enabled: boolean;
  label: string;
  volume24h: number;
  eventTypes: string[];
}

export interface BoardLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  hideDisabled?: boolean;
  focusProcessId?: string | null;
}

export function edgeWidth(volume: number, maxVolume: number): number {
  if (maxVolume <= 0 || volume <= 0) return 1.1;
  return Math.round((1.1 + 3.4 * Math.sqrt(volume / maxVolume)) * 10) / 10;
}

function barycentre(ids: string[], order: Map<string, number>): number {
  const ranks = ids.map((id) => order.get(id)).filter((r): r is number => r != null);
  if (ranks.length === 0) return Number.POSITIVE_INFINITY;
  return ranks.reduce((a, b) => a + b, 0) / ranks.length;
}

function sortByBarycentre<T extends { id: string }>(
  items: T[],
  neighbours: (id: string) => string[],
  order: Map<string, number>,
): T[] {
  return items
    .map((item, index) => ({ item, index, key: barycentre(neighbours(item.id), order) }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((x) => x.item);
}

export function layoutBoard(board: BoardResponse, options: LayoutOptions = {}): BoardLayout {
  let { sources, processes, destinations, edges } = board;

  if (options.hideDisabled) {
    sources = sources.filter((s) => s.enabled);
    processes = processes.filter((p) => p.enabled);
    destinations = destinations.filter((x) => x.enabled);
    edges = edges.filter((e) => e.enabled);
  }

  if (options.focusProcessId) {
    const pid = options.focusProcessId;
    const keepSources = new Set(
      edges.filter((e) => e.kind === 'trigger' && e.to === pid).map((e) => e.from),
    );
    const keepDestinations = new Set(
      edges.filter((e) => e.kind === 'binding' && e.from === pid).map((e) => e.to),
    );
    processes = processes.filter((p) => p.id === pid);
    sources = sources.filter((s) => keepSources.has(s.id));
    destinations = destinations.filter((x) => keepDestinations.has(x.id));
    edges = edges.filter((e) => (e.kind === 'trigger' ? e.to === pid : e.from === pid));
  }

  const present = new Set([...sources, ...processes, ...destinations].map((n) => n.id));
  edges = edges.filter((e) => present.has(e.from) && present.has(e.to));

  const sourceOrder = new Map(sources.map((s, i) => [s.id, i]));
  const orderedProcesses = sortByBarycentre(
    processes,
    (id) => edges.filter((e) => e.kind === 'trigger' && e.to === id).map((e) => e.from),
    sourceOrder,
  );
  const processOrder = new Map(orderedProcesses.map((p, i) => [p.id, i]));
  const orderedDestinations = sortByBarycentre(
    destinations,
    (id) => edges.filter((e) => e.kind === 'binding' && e.to === id).map((e) => e.from),
    processOrder,
  );

  const destinationRow = (x: BoardDestinationNode) =>
    x.meters.length > 0 ? COLUMNS.destination.row : 110;
  const heights = {
    source: sources.length * COLUMNS.source.row,
    process: orderedProcesses.length * COLUMNS.process.row,
    destination: orderedDestinations.reduce((h, x) => h + destinationRow(x), 0),
  };
  const height = Math.max(heights.source, heights.process, heights.destination, 1);
  const offset = (kind: BoardNodeKind) => Math.round((height - heights[kind]) / 2);

  const nodes: LaidOutNode[] = [
    ...sources.map((s, i) => ({
      id: s.id,
      kind: 'source' as const,
      x: COLUMNS.source.x,
      y: offset('source') + i * COLUMNS.source.row,
      width: COLUMNS.source.width,
      node: s,
    })),
    ...orderedProcesses.map((p, i) => ({
      id: p.id,
      kind: 'process' as const,
      x: COLUMNS.process.x,
      y: offset('process') + i * COLUMNS.process.row,
      width: COLUMNS.process.width,
      node: p,
    })),
  ];
  let y = offset('destination');
  for (const x of orderedDestinations) {
    nodes.push({
      id: x.id,
      kind: 'destination',
      x: COLUMNS.destination.x,
      y,
      width: COLUMNS.destination.width,
      node: x,
    });
    y += destinationRow(x);
  }

  const maxTrigger = Math.max(
    0,
    ...edges.filter((e) => e.kind === 'trigger').map((e) => e.volume24h),
  );
  const maxBinding = Math.max(
    0,
    ...edges.filter((e) => e.kind === 'binding').map((e) => e.volume24h),
  );

  return {
    nodes,
    edges: edges.map((e) => ({
      id: e.id,
      kind: e.kind,
      source: e.from,
      target: e.to,
      width: edgeWidth(e.volume24h, e.kind === 'trigger' ? maxTrigger : maxBinding),
      dashed: !e.enabled || e.recent === 0,
      live: e.enabled && e.recent > 0,
      enabled: e.enabled,
      label: e.label || e.eventTypes.join(', '),
      volume24h: e.volume24h,
      eventTypes: e.eventTypes,
    })),
    width: COLUMNS.destination.x + COLUMNS.destination.width,
    height,
  };
}
