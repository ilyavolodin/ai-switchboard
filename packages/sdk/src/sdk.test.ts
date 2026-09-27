import { describe, expect, it } from 'vitest';

import {
  CapabilityError,
  createHttpClient,
  dedupeKey,
  definePlugin,
  hostMatches,
  InvokeError,
  isInvokeError,
  isTransportError,
  parseRetryAfter,
  safeEqual,
  secretPaths,
  signHmac,
  TransportError,
  validateAgainst,
  validatePlugin,
  verifyHmac,
  type SourceType,
} from './index.js';
import { createStubHttp, rawRequest, scrubRequest } from './testing/index.js';

const sourceType = (overrides: Partial<SourceType> = {}): SourceType => ({
  id: 'demo',
  displayName: 'Demo',
  mode: 'push',
  settingsSchema: { type: 'object', properties: { token: { type: 'string', 'x-secret': true } } },
  eventTypes: [
    {
      type: 'demo.item.created',
      title: 'Item created',
      description: 'An item was created',
      attributes: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      examples: [{ name: 'x', tags: ['a'] }],
    },
  ],
  create: () => ({
    health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date().toISOString() }),
  }),
  ...overrides,
});

describe('dedupeKey', () => {
  it('uses the artifact version when present', () => {
    expect(
      dedupeKey('github.pr.labeled', { kind: 'github.pr', id: '482', version: 'v2' }, 'd1'),
    ).toBe('github.pr.labeled:github.pr:482:v2');
  });
  it('falls back to the delivery id', () => {
    expect(
      dedupeKey('datadog.monitor.alert', { kind: 'datadog.monitor', id: '9' }, 'cycle-3'),
    ).toBe('datadog.monitor.alert:datadog.monitor:9:cycle-3');
  });
});

describe('hmac', () => {
  const secret = 's3cret';
  const payload = Buffer.from('{"a":1}');
  it('verifies a correct prefixed signature', () => {
    const sig = `sha256=${signHmac({ secret, payload })}`;
    expect(verifyHmac({ secret, payload, signature: sig, prefix: 'sha256=' })).toBe(true);
  });
  it('rejects a wrong, missing or malformed signature', () => {
    expect(verifyHmac({ secret, payload, signature: 'sha256=deadbeef', prefix: 'sha256=' })).toBe(
      false,
    );
    expect(verifyHmac({ secret, payload, signature: undefined })).toBe(false);
    expect(verifyHmac({ secret, payload, signature: 'nothex', prefix: 'sha256=' })).toBe(false);
    expect(verifyHmac({ secret: '', payload, signature: signHmac({ secret: '', payload }) })).toBe(
      false,
    );
  });
  it('compares shared secrets in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
  });
});

describe('HttpClient', () => {
  it('matches host globs', () => {
    expect(hostMatches('acme.atlassian.net', '*.atlassian.net')).toBe(true);
    expect(hostMatches('atlassian.net', '*.atlassian.net')).toBe(false);
    expect(hostMatches('api.github.com', 'api.github.com')).toBe(true);
    expect(hostMatches('evil.com', '*')).toBe(true);
  });

  it('refuses hosts outside the declared capability', async () => {
    const stub = createStubHttp(() => ({ json: {} }), ['api.github.com']);
    await expect(stub.client.get('https://evil.example/x')).rejects.toBeInstanceOf(CapabilityError);
    await expect(stub.client.get('https://api.github.com/x')).resolves.toMatchObject({
      status: 200,
    });
  });

  it('sends JSON and query parameters', async () => {
    const stub = createStubHttp((req) => ({
      json: { echo: req.json(), q: req.url.searchParams.get('a') },
    }));
    const res = await stub.client.post('https://x.test/p', {
      json: { hello: 1 },
      query: { a: 'b' },
    });
    expect(res.json()).toEqual({ echo: { hello: 1 }, q: 'b' });
    expect(stub.calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('marks connection refusal as not sent and other failures as sent', async () => {
    const refused = createHttpClient({
      fetch: () =>
        Promise.reject(
          Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
        ),
    });
    const err1 = await refused.get('https://x.test').catch((e: unknown) => e);
    expect(isTransportError(err1) && err1.sent).toBe(false);

    const reset = createHttpClient({
      fetch: () =>
        Promise.reject(
          Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
        ),
    });
    const err2 = await reset.get('https://x.test').catch((e: unknown) => e);
    expect(isTransportError(err2) && err2.sent).toBe(true);
  });

  it('parses Retry-After as seconds or a date', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now)).toBe(60);
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
  });
});

describe('errors', () => {
  it('are recognisable by duck typing', () => {
    expect(isTransportError(new TransportError('x', { sent: false }))).toBe(true);
    expect(isInvokeError(new InvokeError('x', { status: 503 }))).toBe(true);
    expect(isInvokeError(new Error('x'))).toBe(false);
  });
});

describe('validatePlugin', () => {
  it('accepts a well-formed plugin', () => {
    expect(
      validatePlugin(definePlugin({ id: 'demo', displayName: 'Demo', sources: [sourceType()] })),
    ).toEqual([]);
  });

  it('rejects non-kebab ids, foreign event prefixes, nested attributes and bad examples', () => {
    const bad = sourceType({
      id: 'Demo_Source',
      eventTypes: [
        {
          type: 'other.item.created',
          title: 't',
          description: 'd',
          attributes: {
            type: 'object',
            properties: { nested: { type: 'object' }, n: { type: 'number' } },
          },
          examples: [{ n: 'not a number' }],
        },
      ],
    });
    const errors = validatePlugin(
      definePlugin({ id: 'demo', displayName: 'Demo', sources: [bad] }),
    );
    expect(errors.join('\n')).toMatch(/kebab-case/);
    expect(errors.join('\n')).toMatch(/must start with "Demo_Source\."/);
    expect(errors.join('\n')).toMatch(/"nested" must be a scalar/);
    expect(errors.join('\n')).toMatch(/example 0 invalid/);
  });

  it('rejects an event type without examples and duplicate types', () => {
    const spec = { ...sourceType().eventTypes[0]!, examples: [] };
    const errors = validatePlugin(
      definePlugin({
        id: 'demo',
        displayName: 'Demo',
        sources: [sourceType({ eventTypes: [spec, spec] })],
      }),
    );
    expect(errors.join('\n')).toMatch(/at least one example/);
    expect(errors.join('\n')).toMatch(/duplicate event type/);
  });
});

describe('schema helpers', () => {
  it('validates values and formats errors', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(validateAgainst(schema, { a: 'x' }).valid).toBe(true);
    const check = validateAgainst(schema, {});
    expect(check.valid).toBe(false);
    expect(check.errors[0]).toMatch(/required property 'a'/);
  });

  it('accepts UI annotation keywords', () => {
    expect(
      validateAgainst({ type: 'string', 'x-secret': true, 'x-widget': 'textarea' }, 'x').valid,
    ).toBe(true);
  });

  it('finds secret paths', () => {
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
});

describe('fixture recorder', () => {
  it('scrubs secrets, drops auth headers and re-signs', () => {
    const req = rawRequest({
      body: { token: 'live-token-123', title: 'hi' },
      headers: { Authorization: 'Bearer live-token-123', 'X-Sig': 'old' },
    });
    const rec = scrubRequest(req, {
      secrets: ['live-token-123'],
      resign: (body) => ({ 'x-sig': signHmac({ secret: 'fixture', payload: body }) }),
    });
    expect(rec.body).not.toContain('live-token-123');
    expect(rec.headers.authorization).toBeUndefined();
    expect(rec.headers['x-sig']).toBe(
      signHmac({ secret: 'fixture', payload: Buffer.from(rec.body) }),
    );
  });
});
