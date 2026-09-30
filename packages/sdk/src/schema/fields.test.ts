import { describe, expect, it } from 'vitest';

import { schemaFields, secretPaths } from './fields.js';

describe('schemaFields', () => {
  it('lists every property with its dotted path, nested ones after their parent', () => {
    const fields = schemaFields({
      type: 'object',
      properties: {
        name: { type: 'string' },
        auth: { type: 'object', properties: { token: { type: 'string' } } },
      },
    });
    expect(fields.map((f) => f.path)).toEqual(['name', 'auth', 'auth.token']);
  });

  it('descends into nested properties that do not declare type "object"', () => {
    const fields = schemaFields({
      properties: { auth: { properties: { key: { type: 'string' } } } },
    });
    expect(fields.map((f) => f.path)).toEqual(['auth', 'auth.key']);
  });

  it('gives nothing for a schema without properties', () => {
    expect(schemaFields({ type: 'string' })).toEqual([]);
    expect(schemaFields({ properties: 'nope' })).toEqual([]);
  });
});

describe('secretPaths', () => {
  it('finds x-secret fields at any depth', () => {
    expect(
      secretPaths({
        type: 'object',
        properties: {
          token: { type: 'string', 'x-secret': true },
          auth: { type: 'object', properties: { key: { type: 'string', 'x-secret': true } } },
          name: { type: 'string' },
        },
      }),
    ).toEqual(['token', 'auth.key']);
  });

  it('finds an x-secret field under a nested object without an explicit type', () => {
    expect(
      secretPaths({ properties: { auth: { properties: { token: { 'x-secret': true } } } } }),
    ).toEqual(['auth.token']);
  });
});
