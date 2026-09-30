import { describe, expect, it } from 'vitest';

import { artifactFields, toArtifactRef } from './artifact.js';

describe('artifact refs from untrusted values', () => {
  it('keeps only the string fields', () => {
    expect(artifactFields({ kind: 'github.pr', id: 7, url: 'u', extra: 'x' })).toEqual({
      kind: 'github.pr',
      url: 'u',
    });
    expect(artifactFields('nope')).toEqual({});
  });

  it.each([
    [{ kind: 'k', id: '1', version: 'v', extra: 1 }, { kind: 'k', id: '1', version: 'v' }],
    [{ kind: 'k' }, null],
    [null, null],
    [['k', '1'], null],
  ])('toArtifactRef(%j) → %j', (value, want) => {
    expect(toArtifactRef(value)).toEqual(want);
  });
});
