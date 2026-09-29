import { describe, expect, it } from 'vitest';

import {
  installedMessage,
  installOutcome,
  installPluginPrompt,
  isPackageName,
  kindLabel,
  parsePackageSpec,
} from './pluginModel.js';

describe('package specs', () => {
  it.each([
    ['@acme/x@^1', { package: '@acme/x', range: '^1' }],
    ['@acme/x', { package: '@acme/x' }],
    ['left-pad@', { package: 'left-pad' }],
    ['  plain  ', { package: 'plain' }],
  ])('%j', (input, expected) => {
    expect(parsePackageSpec(input)).toEqual(expected);
  });

  it('accepts npm names only', () => {
    expect(isPackageName('@scope/pkg')).toBe(true);
    expect(isPackageName('not a name')).toBe(false);
  });
});

describe('installing on the way to a new instance', () => {
  const base = { name: '@acme/x', pendingRestart: false, statusMessage: null, types: [] };

  it.each([
    [{ ...base, pendingRestart: true }, 'note', /restart Switchboard/],
    [base, 'note', /contributes no source type\.$/],
    [{ ...base, statusMessage: 'bad manifest' }, 'note', /no source type: bad manifest$/],
  ])('says why it cannot continue', (added, kind, note) => {
    const out = installOutcome(added, 'source');
    expect(out.kind).toBe(kind);
    expect(out.kind === 'note' && out.note).toMatch(note);
  });

  it('continues into the types of the kind asked for', () => {
    const added = {
      ...base,
      types: [
        { kind: 'source' as const, typeId: 'x.a', displayName: 'A', instanceCount: 0 },
        { kind: 'destination' as const, typeId: 'x.b', displayName: 'B', instanceCount: 0 },
      ],
    };
    expect(installOutcome(added, 'source')).toEqual({ kind: 'continue', typeIds: ['x.a'] });
  });

  it('words the prompt and the result with the verb of the page', () => {
    expect(installPluginPrompt({ package: 'p', range: '^1' }, 'Add', 'Then.')).toMatchObject({
      title: 'Add p@^1?',
      confirmLabel: 'Add plugin',
    });
    expect(installedMessage({ pendingRestart: false }, 'Install')).toBe('Installed · ready to use');
    expect(installedMessage({ pendingRestart: true }, 'Add')).toBe('Added · restart to apply');
    expect(kindLabel('secret_provider')).toBe('secret provider');
  });
});
