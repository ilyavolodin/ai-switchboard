import { describe, expect, it } from 'vitest';

import { buildFixtures, IDS } from '../../api/fixtures.js';
import { TEST_NOW } from '../../test/constants.js';
import { COLUMNS, edgeWidth, layoutBoard } from './layout.js';

const f = buildFixtures(TEST_NOW);

describe('layoutBoard', () => {
  it('puts sources, processes and destinations in three columns', () => {
    const { nodes } = layoutBoard(f.board);
    const xs = (kind: string) => [...new Set(nodes.filter((n) => n.kind === kind).map((n) => n.x))];
    expect(xs('source')).toEqual([COLUMNS.source.x]);
    expect(xs('process')).toEqual([COLUMNS.process.x]);
    expect(xs('destination')).toEqual([COLUMNS.destination.x]);
    expect(nodes).toHaveLength(
      f.board.sources.length + f.board.processes.length + f.board.destinations.length,
    );
  });

  it('is deterministic', () => {
    expect(layoutBoard(f.board)).toEqual(layoutBoard(structuredClone(f.board)));
  });

  it('orders processes next to the sources that trigger them', () => {
    const order = layoutBoard(f.board)
      .nodes.filter((n) => n.kind === 'process')
      .map((n) => n.id);
    expect(order.indexOf(IDS.processes.prReview)).toBeLessThan(order.indexOf(IDS.processes.sizer));
    expect(order.slice(-2).sort()).toEqual([IDS.processes.nightly, IDS.processes.scorecard].sort());
  });

  it('draws edge width from 24 h volume and dashes quiet edges', () => {
    const { edges } = layoutBoard(f.board);
    const byId = Object.fromEntries(edges.map((e) => [e.id, e]));
    const busiest = byId[`trigger:${IDS.sources.linear}->${IDS.processes.triage}`];
    const quiet = byId[`trigger:${IDS.sources.datadog}->${IDS.processes.triage}`];
    expect(busiest?.width).toBe(4.5);
    expect(busiest?.live).toBe(true);
    expect(quiet?.dashed).toBe(true);
    expect(quiet?.live).toBe(false);
    expect(quiet!.width).toBeLessThan(busiest!.width);
    expect(edgeWidth(0, 100)).toBe(1.1);
    expect(edgeWidth(25, 100)).toBe(2.8);
  });

  it('hides disabled nodes and their edges', () => {
    const { nodes, edges } = layoutBoard(f.board, { hideDisabled: true });
    const ids = nodes.map((n) => n.id);
    expect(ids).not.toContain(IDS.processes.depBumps);
    expect(ids).not.toContain(IDS.sources.slack);
    expect(edges.some((e) => e.target === IDS.processes.depBumps)).toBe(false);
  });

  it('focuses one process and its neighbourhood', () => {
    const { nodes, edges } = layoutBoard(f.board, { focusProcessId: IDS.processes.autofix });
    expect(nodes.map((n) => n.id).sort()).toEqual(
      [IDS.sources.linear, IDS.processes.autofix, IDS.destinations.routines].sort(),
    );
    expect(edges).toHaveLength(2);
  });
});
