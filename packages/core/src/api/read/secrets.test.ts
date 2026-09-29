import { describe, expect, it } from 'vitest';

import type { SecretOwnerDTO } from '../contract.js';
import { storedByOf } from './secrets.js';

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
