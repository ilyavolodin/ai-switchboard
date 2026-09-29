import { describe, expect, it } from 'vitest';

import { withSettings } from './settings.js';
import { createTestContext } from './testing/stubs.js';

const schema = {
  type: 'object',
  required: ['url'],
  properties: { url: { type: 'string' }, retries: { type: 'integer', default: 3 } },
};

class BadSettings extends Error {
  override readonly name = 'BadSettings';
}

describe('withSettings', () => {
  const create = withSettings<{ url: string; retries: number }, string>(
    schema,
    'acme settings',
    (s) => `${s.url}:${String(s.retries)}`,
  );

  it('hands create the validated settings with defaults applied', () => {
    const given = { url: 'https://acme.test' };
    expect(create(given, createTestContext())).toBe('https://acme.test:3');
    expect(given).toEqual({ url: 'https://acme.test' });
  });

  it('throws Invalid <what> for bad settings', () => {
    expect(() => create({}, createTestContext())).toThrow(/^Invalid acme settings: /);
  });

  it('uses the error class from options', () => {
    const strict = withSettings(schema, 'acme settings', () => 1, { error: BadSettings });
    expect(() => strict({}, createTestContext())).toThrow(BadSettings);
  });
});
