import { describe, expect, it } from 'vitest';

import { evaluationCounts } from './expression.js';

describe('evaluationCounts', () => {
  it('counts an errored row as an error only, whatever its result', () => {
    expect(
      evaluationCounts([
        { result: true },
        { result: false },
        { result: false },
        { result: true, error: 'x is not defined' },
        { result: false, error: 'timeout' },
      ]),
    ).toEqual({ true: 1, false: 2, errors: 2 });
  });

  it('is all zeros for no rows', () => {
    expect(evaluationCounts([])).toEqual({ true: 0, false: 0, errors: 0 });
  });
});
