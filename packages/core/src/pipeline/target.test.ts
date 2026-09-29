import { describe, expect, it } from 'vitest';

import { effectiveTarget } from './target.js';

describe('effectiveTarget', () => {
  it.each([
    ['merges an object over the defaults', { a: 2 }, { a: 1, b: 1 }, { a: 2, b: 1 }],
    ['takes the defaults for a missing target', undefined, { a: 1 }, { a: 1 }],
    ['takes the defaults for null', null, { a: 1 }, { a: 1 }],
    ['keeps a scalar target', 'routine-1', { a: 1 }, 'routine-1'],
    ['keeps an array target', ['x'], { a: 1 }, ['x']],
  ])('%s', (_name, target, defaults, want) => {
    expect(effectiveTarget(target, defaults)).toEqual(want);
  });
});
