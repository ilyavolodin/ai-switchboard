import { describe, expect, it } from 'vitest';

import { KEEP, mapJson, mapJsonAsync, walkJson } from './json.js';

const doc = { a: 'x', list: ['y', { b: 'z' }], n: 1, none: null };

describe('walkJson', () => {
  it('visits every node with its path, parents first', () => {
    const seen: string[] = [];
    walkJson(doc, (_node, path) => {
      seen.push(path);
    });
    expect(seen).toEqual(['', 'a', 'list', 'list[0]', 'list[1]', 'list[1].b', 'n', 'none']);
  });

  it('skips the children of a node the visitor handled', () => {
    const seen: string[] = [];
    walkJson(doc, (node, path) => {
      seen.push(path);
      return Array.isArray(node);
    });
    expect(seen).toEqual(['', 'a', 'list', 'n', 'none']);
  });
});

describe('mapJson', () => {
  it('replaces nodes and keeps the rest, without touching the input', () => {
    const out = mapJson(doc, (node) => (typeof node === 'string' ? node.toUpperCase() : KEEP));
    expect(out).toEqual({ a: 'X', list: ['Y', { b: 'Z' }], n: 1, none: null });
    expect(doc.a).toBe('x');
  });

  it('can replace a whole container, including with undefined', () => {
    const out = mapJson(doc, (_node, path) => (path === 'list' ? undefined : KEEP));
    expect(out).toEqual({ a: 'x', list: undefined, n: 1, none: null });
  });
});

describe('mapJsonAsync', () => {
  it('maps like mapJson and visits siblings in parallel', async () => {
    const started: string[] = [];
    const out = await mapJsonAsync(['p', 'q'], async (node, path) => {
      if (typeof node !== 'string') return KEEP;
      started.push(path);
      await Promise.resolve();
      expect(started).toHaveLength(2);
      return `${node}!`;
    });
    expect(out).toEqual(['p!', 'q!']);
  });
});
