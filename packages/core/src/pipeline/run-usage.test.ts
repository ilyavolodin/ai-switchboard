import { describe, expect, it } from 'vitest';

import type { UsageDimension } from '@ai-switchboard/sdk';

import { mergeRunUsage } from './run-usage.js';

const dims: UsageDimension[] = [
  { id: 'tokens', title: 'Tokens', unit: 'tokens', aggregate: 'sum', budgetable: true },
  { id: 'peak', title: 'Peak', unit: 'bytes', aggregate: 'max', budgetable: false },
];

describe('mergeRunUsage', () => {
  it.each([
    ['nothing reported keeps the run usage', { tokens: 3 }, undefined, { tokens: 3 }, []],
    ['a later total replaces a sum', { tokens: 3 }, { tokens: 7 }, { tokens: 7 }, []],
    ['a max keeps the peak', { peak: 9 }, { peak: 4 }, { peak: 9 }, []],
    [
      'undeclared keys are dropped and named',
      null,
      { tokens: 1, nope: 2 },
      { tokens: 1 },
      ['nope'],
    ],
    [
      'only undeclared keys keep the run usage',
      { tokens: 2 },
      { nope: 2 },
      { tokens: 2 },
      ['nope'],
    ],
  ] as const)('%s', (_name, previous, report, usage, dropped) => {
    expect(mergeRunUsage(previous, report, dims)).toEqual({ usage, dropped });
  });
});
