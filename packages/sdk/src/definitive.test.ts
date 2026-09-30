import { describe, expect, it } from 'vitest';

import { parseDefinitive } from './definitive.js';
import { isInvokeError } from './errors.js';

const schema = {
  type: 'object',
  required: ['url'],
  properties: { url: { type: 'string' }, retries: { type: 'integer', default: 2 } },
};

describe('parseDefinitive', () => {
  it('returns a validated copy with defaults', () => {
    const value = { url: '/x' };
    expect(parseDefinitive(schema, value, 'target')).toEqual({ url: '/x', retries: 2 });
    expect(value).toEqual({ url: '/x' });
  });

  it('throws a definitive InvokeError that was sent, so the run fails instead of retrying', () => {
    const err: unknown = (() => {
      try {
        parseDefinitive(schema, { url: 1 }, 'http target');
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(isInvokeError(err)).toBe(true);
    expect(err).toMatchObject({ definitive: true, sent: true });
    expect((err as Error).message).toMatch(/^Invalid http target: /);
  });
});
