import { describe, expect, it } from 'vitest';

import { isSdkCompatible, readSwitchboardField } from './package-manifest.js';

describe('readSwitchboardField', () => {
  const cases: { name: string; pkg: unknown; expected: unknown }[] = [
    { name: 'no package', pkg: null, expected: undefined },
    { name: 'no field', pkg: { name: 'x' }, expected: undefined },
    { name: 'a non-object field', pkg: { switchboard: 'yes' }, expected: undefined },
    {
      name: 'every part',
      pkg: { switchboard: { entry: 'dist/p.js', source: 'src/p.ts', sdk: '^2.0.0' } },
      expected: { entry: 'dist/p.js', source: 'src/p.ts', sdk: '^2.0.0' },
    },
    {
      name: 'empty and non-string parts are absent',
      pkg: { switchboard: { entry: '', source: 3, sdk: '^2.0.0' } },
      expected: { entry: undefined, source: undefined, sdk: '^2.0.0' },
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(readSwitchboardField(c.pkg)).toEqual(c.expected);
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
