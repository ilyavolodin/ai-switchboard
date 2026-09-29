import { describe, expect, it } from 'vitest';

import {
  formatSecretRef,
  isSecretProviderSegment,
  isSecretRef,
  parseSecretRef,
} from './secret-refs.js';

describe('secret references', () => {
  it.each([
    ['secret://env/GITHUB_TOKEN', { provider: 'env', name: 'GITHUB_TOKEN' }],
    ['secret://vault/team/a/token', { provider: 'vault', name: 'team/a/token' }],
    ['secret://env/', null],
    ['secret:///name', null],
    ['secret://env', null],
    ['env/GITHUB_TOKEN', null],
    [42, null],
    [undefined, null],
  ])('parseSecretRef(%j) is %j', (value, expected) => {
    expect(parseSecretRef(value)).toEqual(expected);
  });

  it('formats what it parses', () => {
    const ref = { provider: 'file', name: 'slack/webhook' };
    expect(parseSecretRef(formatSecretRef(ref))).toEqual(ref);
    expect(formatSecretRef(ref)).toBe('secret://file/slack/webhook');
  });

  it('recognises the scheme', () => {
    expect(isSecretRef('secret://env/X')).toBe(true);
    expect(isSecretRef('https://x')).toBe(false);
    expect(isSecretRef(null)).toBe(false);
  });

  it.each([
    ['env', true],
    ['my-vault_1.prod', true],
    ['has space', false],
    ['a/b', false],
    ['', false],
  ])('isSecretProviderSegment(%j) is %j', (value, expected) => {
    expect(isSecretProviderSegment(value)).toBe(expected);
  });
});
