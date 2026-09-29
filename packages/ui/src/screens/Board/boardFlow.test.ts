import { describe, expect, it } from 'vitest';

import { buildFixtures } from '../../api/fixtures.js';
import { TEST_NOW } from '../../test/constants.js';
import {
  disabledCount,
  edgeAriaLabel,
  mergeDimensions,
  neighboursOf,
  toFlowEdges,
  toFlowNodes,
} from './boardFlow.js';
import { attentionHref, keyFacts, nodeHref } from './facts.js';
import { layoutBoard } from './layout.js';

const f = buildFixtures(TEST_NOW);
const layout = layoutBoard(f.board);
const nowMs = TEST_NOW;
const noop = () => undefined;

describe('neighboursOf', () => {
  it('is nothing without a hovered node, and the node plus its direct links otherwise', () => {
    const edges = [
      { source: 's', target: 'p' },
      { source: 'p', target: 'd' },
      { source: 'x', target: 'y' },
    ] as Parameters<typeof neighboursOf>[0];
    expect(neighboursOf(edges, null)).toBeNull();
    expect([...(neighboursOf(edges, 'p') ?? [])].sort()).toEqual(['d', 'p', 's']);
  });
});

describe('toFlowNodes and toFlowEdges', () => {
  it('highlights the hovered node and dims what it does not touch', () => {
    const edge = layout.edges[0];
    if (!edge) throw new Error('the fixture board has edges');
    const nodes = toFlowNodes(layout, { hovered: edge.source, measured: {}, nowMs, onHover: noop });
    const hovered = nodes.find((n) => n.id === edge.source);
    expect(hovered?.data.highlighted).toBe(true);
    expect(hovered?.zIndex).toBe(10);
    expect(nodes.find((n) => n.id === edge.target)?.data.dimmed).toBe(false);
    expect(nodes.some((n) => n.data.dimmed)).toBe(true);

    const edges = toFlowEdges(layout, edge.source, false);
    expect(edges.find((e) => e.id === edge.id)?.data?.showLabel).toBe(true);
  });

  it('hands measured sizes back to their nodes', () => {
    const id = layout.nodes[0]?.id ?? '';
    const nodes = toFlowNodes(layout, {
      hovered: null,
      measured: { [id]: { width: 10, height: 20 } },
      nowMs,
      onHover: noop,
    });
    expect(nodes[0]?.measured).toEqual({ width: 10, height: 20 });
    expect(nodes.every((n) => !n.data.dimmed)).toBe(true);
  });

  it('labels edges for screen readers', () => {
    const trigger = layout.edges.find((e) => e.kind === 'trigger');
    expect(trigger && edgeAriaLabel(trigger)).toMatch(/^Trigger .* events in 24 h$/);
  });

  it('counts every disabled node', () => {
    const expected = [...f.board.sources, ...f.board.processes, ...f.board.destinations].filter(
      (x) => !x.enabled,
    ).length;
    expect(disabledCount(f.board)).toBe(expected);
  });
});

describe('mergeDimensions', () => {
  it('keeps the same object when nothing changed', () => {
    const prev = { a: { width: 1, height: 2 } };
    expect(mergeDimensions(prev, [{ id: 'a', dimensions: { width: 1, height: 2 } }])).toBe(prev);
    expect(mergeDimensions(prev, [{ id: 'b', dimensions: { width: 3, height: 4 } }])).toEqual({
      a: { width: 1, height: 2 },
      b: { width: 3, height: 4 },
    });
  });
});

describe('facts', () => {
  it('links nodes and attention items to their pages', () => {
    expect(nodeHref({ kind: 'process', id: 'p 1' })).toBe('/processes/p%201');
    expect(nodeHref({ kind: 'destination', id: 'd' })).toBe('/destinations/d');
    expect(attentionHref({ targetKind: 'approval', targetId: 'b' })).toBe('/approvals');
    expect(attentionHref({ targetKind: 'plugin', targetId: 'x' })).toBe('/plugins');
    expect(attentionHref({ targetKind: 'source', targetId: 's' })).toBe('/sources/s');
  });

  it('gives each node three short facts', () => {
    for (const n of layout.nodes) expect(keyFacts(n, nowMs)).toHaveLength(3);
    const source = layout.nodes.find((n) => n.kind === 'source');
    expect(source && keyFacts(source, nowMs)[1]).toMatch(/events in 24 h$/);
  });
});
