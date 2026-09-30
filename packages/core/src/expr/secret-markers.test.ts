import { describe, expect, it } from 'vitest';

import {
  collectSecretMarkers,
  isSecretRefMarker,
  neutralizeSecretMarkers,
  replaceSecretMarkers,
  resolveSecretMarkers,
  secretRefString,
} from './secret-markers.js';

const marker = (ref: string) => ({ $secretRef: ref });

describe('secretRefString', () => {
  it.each([
    ['env/TOKEN', 'secret://env/TOKEN'],
    ['  secret://vault/a/b ', 'secret://vault/a/b'],
  ])('%s becomes %s', (name, ref) => {
    expect(secretRefString(name)).toBe(ref);
  });

  it.each(['TOKEN', '/x', 'env/', 'secret://env/'])('rejects %s', (name) => {
    expect(() => secretRefString(name)).toThrow(/provider>\/<name>/);
  });
});

describe('markers', () => {
  const input = { a: marker('secret://env/A'), list: [marker('secret://env/B'), 'plain'] };

  it('recognises only a single-key marker object', () => {
    expect(isSecretRefMarker(marker('secret://env/A'))).toBe(true);
    expect(isSecretRefMarker({ $secretRef: 'x', other: 1 })).toBe(false);
    expect(isSecretRefMarker([marker('x')])).toBe(false);
  });

  it('collects and replaces markers anywhere', () => {
    expect([...collectSecretMarkers(input)]).toEqual(['secret://env/A', 'secret://env/B']);
    expect(replaceSecretMarkers(input, (ref) => ref.slice(-1))).toEqual({
      a: 'A',
      list: ['B', 'plain'],
    });
  });

  it('resolves every marker and reports the values', async () => {
    const out = await resolveSecretMarkers(input, (ref) => Promise.resolve(`v-${ref.slice(-1)}`));
    expect(out).toEqual({ value: { a: 'v-A', list: ['v-B', 'plain'] }, secrets: ['v-A', 'v-B'] });
  });

  it('neutralizes forged markers to null and leaves marker-free data as is', () => {
    expect(neutralizeSecretMarkers(input)).toEqual({ a: null, list: [null, 'plain'] });
    const clean = { a: 1 };
    expect(neutralizeSecretMarkers(clean)).toBe(clean);
  });
});
