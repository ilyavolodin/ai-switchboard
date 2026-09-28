import { describe, expect, it } from 'vitest';

import { upgradeLegacyConfiguration } from './config-io.js';

describe('upgradeLegacyConfiguration (deprecated executor names)', () => {
  it('renames executors: and a process executor: binding', () => {
    const { file, errors } = upgradeLegacyConfiguration({
      apiVersion: 'switchboard/v1',
      kind: 'Configuration',
      executors: [{ name: 'Log', type: 'log' }],
      processes: [{ name: 'P', executor: { instance: 'Log', target: {} } }],
    });
    expect(errors).toEqual([]);
    expect(file).toEqual({
      apiVersion: 'switchboard/v1',
      kind: 'Configuration',
      destinations: [{ name: 'Log', type: 'log' }],
      processes: [{ name: 'P', destination: { instance: 'Log', target: {} } }],
    });
  });

  it('leaves a current file alone', () => {
    const current = {
      destinations: [{ name: 'Log', type: 'log' }],
      processes: [{ name: 'P', destination: { instance: 'Log', target: {} } }],
    };
    expect(upgradeLegacyConfiguration(current)).toEqual({ file: current, errors: [] });
  });

  it('refuses both spellings at once', () => {
    const { errors } = upgradeLegacyConfiguration({
      destinations: [],
      executors: [],
      processes: [{ name: 'P', destination: {}, executor: {} }],
    });
    expect(errors).toEqual([
      'use either destinations or executors (deprecated), not both',
      'processes[0]: use either destination or executor (deprecated), not both',
    ]);
  });
});
