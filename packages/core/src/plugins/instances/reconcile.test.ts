import { describe, expect, it } from 'vitest';

import { diffInstances } from './reconcile.js';

describe('diffInstances', () => {
  const built = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 1],
  ]);

  it('finds added, changed and removed instances', () => {
    expect(
      diffInstances(
        [
          { id: 'a', version: 1 },
          { id: 'b', version: 3 },
          { id: 'd', version: 1 },
        ],
        built,
      ),
    ).toEqual({ added: ['d'], changed: ['b'], removed: ['c'] });
  });

  it('reports nothing when every row is built at its version', () => {
    expect(
      diffInstances(
        [
          { id: 'a', version: 1 },
          { id: 'b', version: 2 },
          { id: 'c', version: 1 },
        ],
        built,
      ),
    ).toEqual({ added: [], changed: [], removed: [] });
  });

  it('treats a lower version as a change (a row replaced under the same id)', () => {
    expect(diffInstances([{ id: 'b', version: 1 }], new Map([['b', 2]])).changed).toEqual(['b']);
  });

  it('leaves skipped ids (builds in flight) for the next pass', () => {
    const skip = (id: string) => id === 'b' || id === 'c' || id === 'd';
    expect(
      diffInstances(
        [
          { id: 'a', version: 1 },
          { id: 'b', version: 3 },
          { id: 'd', version: 1 },
        ],
        built,
        skip,
      ),
    ).toEqual({ added: [], changed: [], removed: [] });
  });

  it('builds everything on an empty replica and drops everything when the table is empty', () => {
    expect(diffInstances([{ id: 'x', version: 4 }], new Map()).added).toEqual(['x']);
    expect(diffInstances([], built).removed).toEqual(['a', 'b', 'c']);
  });
});
