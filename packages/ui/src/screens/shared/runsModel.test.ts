import { describe, expect, it } from 'vitest';

import { runKindText, usageText } from './runsModel.js';

describe('runsModel', () => {
  it.each([
    [null, undefined, '—'],
    [{}, undefined, '—'],
    [{ cost: 1.5 }, new Map([['cost', 'usd']]), '$1.50'],
    [
      { cost: 1.5, input: 1200 },
      new Map([
        ['cost', 'usd'],
        ['input', 'tokens'],
      ]),
      '$1.50 · 1.2k tokens',
    ],
  ])('usage %j', (usage, units, text) => {
    expect(usageText(usage, units)).toBe(text);
  });

  it('marks a dry run in the kind', () => {
    expect(runKindText({ kind: 'event', dryRun: true })).toBe('event · dry run');
    expect(runKindText({ kind: 'sweep', dryRun: false })).toBe('sweep');
  });
});
