import { describe, expect, it } from 'vitest';

import { isSdkCompatible, parseSwitchboardField } from './package-manifest.js';

describe('parseSwitchboardField', () => {
  const cases: { name: string; pkg: unknown; expected: unknown }[] = [
    {
      name: 'no package',
      pkg: null,
      expected: { ok: false, reason: expect.stringMatching(/no "switchboard" field/) },
    },
    {
      name: 'no field',
      pkg: { name: 'x' },
      expected: { ok: false, reason: expect.stringMatching(/no "switchboard" field/) },
    },
    {
      name: 'a non-object field',
      pkg: { switchboard: 'yes' },
      expected: { ok: false, reason: expect.stringMatching(/no "switchboard" field/) },
    },
    {
      name: 'every part',
      pkg: { switchboard: { entry: 'dist/p.js', source: 'src/p.ts', sdk: '^2.0.0' } },
      expected: { ok: true, field: { entry: 'dist/p.js', source: 'src/p.ts', sdk: '^2.0.0' } },
    },
    {
      name: 'a non-string source is absent',
      pkg: { switchboard: { entry: 'dist/p.js', source: 3, sdk: '^2.0.0' } },
      expected: { ok: true, field: { entry: 'dist/p.js', source: undefined, sdk: '^2.0.0' } },
    },
    {
      name: 'an empty entry is refused',
      pkg: { switchboard: { entry: '', source: 'src/p.ts', sdk: '^2.0.0' } },
      expected: { ok: false, reason: expect.stringMatching(/no "entry"/) },
    },
    {
      name: 'a missing sdk range is refused',
      pkg: { switchboard: { entry: 'dist/p.js' } },
      expected: { ok: false, reason: expect.stringMatching(/no "sdk" range/) },
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(parseSwitchboardField(c.pkg)).toEqual(c.expected);
    });
  }
});

describe('isSdkCompatible', () => {
  const cases: { range: string; version: string; ok: boolean }[] = [
    { range: '^2.0.0', version: '2.3.1', ok: true },
    { range: '^2.0.0', version: '3.0.0', ok: false },
    { range: '^2.0.0', version: '2.4.0-beta.1', ok: true },
    { range: '*', version: '2.0.0', ok: true },
    { range: 'not a range', version: '2.0.0', ok: false },
  ];
  for (const c of cases) {
    it(`${c.range} with SDK ${c.version}`, () => {
      expect(isSdkCompatible(c.range, c.version)).toBe(c.ok);
    });
  }
});
