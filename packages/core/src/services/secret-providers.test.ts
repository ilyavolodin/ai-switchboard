import { describe, expect, it } from 'vitest';

import type { SecretOwnerDTO } from '../contract/index.js';
import { sanitizeListing, storedByOf } from './secret-providers.js';

const owners: SecretOwnerDTO[] = [
  { kind: 'destination', id: 'dst', name: 'Routines seat' },
  { kind: 'destination', id: 'dst-2', name: 'Second seat' },
  { kind: 'source', id: 'src', name: 'Linear' },
];

describe('storedByOf', () => {
  it.each([
    ['switchboard-dst-oauthRefreshToken', 'Routines seat'],
    ['switchboard-dst-2-oauthRefreshToken', 'Second seat'],
    ['switchboard-src-token', 'Linear'],
  ])('%s belongs to %s', (name, owner) => {
    expect(storedByOf(name, owners)?.name).toBe(owner);
  });

  it.each(['LINEAR_API_KEY', 'switchboard-unknown-key', 'switchboard-dst-', 'switchboard'])(
    '%s is not host-stored',
    (name) => {
      expect(storedByOf(name, owners)).toBeUndefined();
    },
  );
});

describe('sanitizeListing', () => {
  it('keeps names, descriptions and dates only, once each, in name order', () => {
    expect(
      sanitizeListing([
        { name: 'b', value: 'fixture-secret', description: 'B' },
        { name: 'a', updatedAt: '2026-03-02T10:00:00Z' },
        { name: 'a' },
        { name: '' },
        null,
        { name: 'c', updatedAt: 'yesterday', description: '' },
      ]),
    ).toEqual([
      { name: 'a', updatedAt: '2026-03-02T10:00:00.000Z' },
      { name: 'b', description: 'B' },
      { name: 'c' },
    ]);
  });

  it('refuses a listing that is not an array', () => {
    expect(() => sanitizeListing({ name: 'a' })).toThrow('list() did not return an array');
  });
});
