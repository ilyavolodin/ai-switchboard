import { describe, expect, it } from 'vitest';

import {
  CapabilityError,
  dedupeKey,
  definePlugin,
  ICON_DATA_URI_PREFIX,
  ICON_NAMES,
  iconProblem,
  InvokeError,
  invokeErrorForStatus,
  isCapabilityError,
  isInvokeError,
  isSecretNotFoundError,
  isTransportError,
  SecretNotFoundError,
  parseRetryAfter,
  parseWith,
  safeEqual,
  SchemaMismatchError,
  secretPaths,
  signHmac,
  TransportError,
  tryParse,
  validateAgainst,
  validatePlugin,
  verifyHmac,
  type DestinationType,
  type SourceType,
} from './index.js';
import { createHttpClient, hostMatches } from './host.js';
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
  it('rejects a hex signature with trailing or embedded garbage', () => {
    const hex = signHmac({ secret, payload });
    expect(verifyHmac({ secret, payload, signature: `${hex}zz` })).toBe(false);
    expect(verifyHmac({ secret, payload, signature: `${hex}0` })).toBe(false);
    expect(verifyHmac({ secret, payload, signature: hex.toUpperCase() })).toBe(true);
  });
  it('signs a unicode body and secret as UTF-8, the same as the raw bytes', () => {
    const body = '{"title":"café ✓"}';
    const sig = signHmac({ secret: 'sëcret', payload: body });
    expect(
      verifyHmac({ secret: 'sëcret', payload: Buffer.from(body, 'utf8'), signature: sig }),
    ).toBe(true);
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

  it('checks every redirect hop against the declared capability', async () => {
    const requested: string[] = [];
    // A transport that follows redirects itself unless asked not to, like fetch.
    const fetchLike = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      let url = new URL(input instanceof Request ? input.url : input);
      for (;;) {
        requested.push(`${init?.method ?? 'GET'} ${url.href} ${JSON.stringify(init?.headers)}`);
        const target =
          url.pathname === '/moved'
            ? 'https://api.github.com/final'
            : url.pathname === '/escape'
              ? 'http://169.254.169.254/latest/meta-data'
              : null;
        if (target === null) return Promise.resolve(new Response('{"ok":true}'));
        if (init?.redirect === 'manual')
          return Promise.resolve(
            new Response(null, { status: 302, headers: { location: target } }),
          );
        url = new URL(target);
      }
    };
    const client = createHttpClient({ allowedHosts: ['api.github.com'], fetch: fetchLike });
    await expect(client.get('https://api.github.com/moved')).resolves.toMatchObject({
      status: 200,
    });
    requested.length = 0;
    await expect(
      client.get('https://api.github.com/escape', { headers: { authorization: 'token x' } }),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(requested.some((r) => r.includes('169.254.169.254'))).toBe(false);
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

  it('reports a response body that fails mid-read as a sent TransportError', async () => {
    const client = createHttpClient({
      fetch: () => {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(Object.assign(new TypeError('terminated'), { code: 'ECONNRESET' }));
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      },
    });
    const err = await client.get('https://x.test/slow').catch((e: unknown) => e);
    expect(isTransportError(err)).toBe(true);
    expect(isTransportError(err) && err.sent).toBe(true);
    expect(isTransportError(err) && err.code).toBe('ECONNRESET');
  });

  it('does not add a second content type when the caller set one in another case', async () => {
    const stub = createStubHttp(() => ({ json: {} }));
    await stub.client.post('https://x.test/p', {
      json: { a: 1 },
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    expect(stub.calls[0]?.headers['content-type']).toBe('application/merge-patch+json');
  });

  it('keeps only safe headers on a cross-origin redirect and turns a 303 into a bodiless GET', async () => {
    const seen: { method: string; url: string; headers: Headers; body: unknown }[] = [];
    const client = createHttpClient({
      allowedHosts: ['a.test', 'b.test'],
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        seen.push({
          method: init?.method ?? 'GET',
          url: url.href,
          headers: new Headers(init?.headers),
          body: init?.body,
        });
        return Promise.resolve(
          url.host === 'a.test'
            ? new Response(null, { status: 303, headers: { location: 'https://b.test/done' } })
            : new Response('{}'),
        );
      },
    });
    await client.post('https://a.test/start', {
      json: { a: 1 },
      headers: { Authorization: 'Bearer x', 'X-Api-Key': 'k', accept: 'application/json' },
    });
    expect(seen[1]).toMatchObject({ method: 'GET', url: 'https://b.test/done', body: undefined });
    expect(seen[1]?.headers.get('authorization')).toBeNull();
    expect(seen[1]?.headers.get('content-type')).toBeNull();
    expect(seen[1]?.headers.get('x-api-key')).toBeNull();
    expect(seen[1]?.headers.get('accept')).toBe('application/json');
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

describe('invokeErrorForStatus', () => {
  it('follows the retry rules: 503 retryable, other 4xx definitive, 5xx uncertain', () => {
    const unavailable = invokeErrorForStatus(503, 'busy', { retryAfterSeconds: 30 });
    expect(unavailable).toMatchObject({ status: 503, definitive: false, retryAfterSeconds: 30 });
    expect(invokeErrorForStatus(422, 'bad')).toMatchObject({ status: 422, definitive: true });
    const broken = invokeErrorForStatus(500, 'oops', { retryAfterSeconds: 30 });
    expect(broken).toMatchObject({ status: 500, definitive: false, retryAfterSeconds: undefined });
    expect(isInvokeError(broken)).toBe(true);
  });
});

describe('parseWith / tryParse', () => {
  const schema = {
    type: 'object',
    required: ['url'],
    properties: { url: { type: 'string' }, retries: { type: 'integer', default: 3 } },
  };

  it('returns a copy with defaults applied and leaves the input untouched', () => {
    const input = { url: 'https://x.test' };
    expect(parseWith(schema, input, 'demo settings')).toEqual({
      url: 'https://x.test',
      retries: 3,
    });
    expect(input).toEqual({ url: 'https://x.test' });
    expect(tryParse(schema, input)).toEqual({ url: 'https://x.test', retries: 3 });
  });

  it('throws Invalid <what> as SchemaMismatchError or the given class', () => {
    expect(() => parseWith(schema, {}, 'demo settings')).toThrow(SchemaMismatchError);
    expect(() => parseWith(schema, {}, 'demo settings')).toThrow(/^Invalid demo settings: /);
    class DemoError extends Error {}
    expect(() => parseWith(schema, {}, 'demo settings', { error: DemoError })).toThrow(DemoError);
    expect(tryParse(schema, {})).toBeNull();
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

const destinationType = (overrides: Partial<DestinationType> = {}): DestinationType => ({
  id: 'demo-exec',
  displayName: 'Demo destination',
  settingsSchema: { type: 'object' },
  targetSchema: { type: 'object' },
  inputSchema: { type: 'object' },
  tracking: 'sync',
  idempotentInvoke: false,
  usage: [],
  create: () => ({
    invoke: () => Promise.resolve({ status: 'completed' }),
    health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date().toISOString() }),
  }),
  ...overrides,
});

const svgUri = (svg: string) => ICON_DATA_URI_PREFIX + Buffer.from(svg).toString('base64');

describe('icons', () => {
  it('accepts every built-in icon name and a small SVG data URI', () => {
    for (const name of ICON_NAMES) expect(iconProblem(name)).toBeNull();
    expect(iconProblem(svgUri('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  it('rejects unknown names, other mime types, bad base64, non-SVG payloads and large URIs', () => {
    expect(iconProblem('rocket')).toMatch(/neither a built-in icon name/);
    expect(iconProblem('data:image/png;base64,iVBORw0KGgo=')).toMatch(/SVG only/);
    expect(iconProblem('data:image/svg+xml,<svg></svg>')).toMatch(/SVG only/);
    expect(iconProblem(`${ICON_DATA_URI_PREFIX}not*base64`)).toMatch(/base64/);
    expect(iconProblem(svgUri('<html><script>x</script></html>'))).toMatch(/<svg>/);
    const big = svgUri(`<svg>${'x'.repeat(7000)}</svg>`);
    expect(iconProblem(big)).toMatch(/limit is 8192/);
    expect(iconProblem('')).toMatch(/non-empty/);
  });

  it('validatePlugin reports a bad icon on any kind of type', () => {
    const errors = validatePlugin(
      definePlugin({
        id: 'demo',
        displayName: 'Demo',
        sources: [sourceType({ icon: 'rocket' })],
        destinations: [destinationType({ icon: 'data:text/html;base64,PGI+' })],
      }),
    );
    expect(errors.join('\n')).toMatch(/source demo: icon "rocket"/);
    expect(errors.join('\n')).toMatch(/destination demo-exec: icon data URI must start/);
    expect(
      validatePlugin(
        definePlugin({
          id: 'demo',
          displayName: 'Demo',
          sources: [sourceType({ icon: 'webhook' })],
        }),
      ),
    ).toEqual([]);
  });
});

describe('invokeTimeoutSeconds', () => {
  it('accepts 1 to 3600 seconds and rejects anything else', () => {
    const check = (invokeTimeoutSeconds: number) =>
      validatePlugin(
        definePlugin({
          id: 'demo',
          displayName: 'Demo',
          destinations: [destinationType({ invokeTimeoutSeconds })],
        }),
      );
    expect(check(60)).toEqual([]);
    expect(check(3600)).toEqual([]);
    expect(check(0).join()).toMatch(/invokeTimeoutSeconds must be a number from 1 to 3600/);
    expect(check(7200).join()).toMatch(/invokeTimeoutSeconds/);
    expect(check(Number.NaN).join()).toMatch(/invokeTimeoutSeconds/);
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

describe('definePlugin derives capabilities.secrets', () => {
  const settingsSchema = {
    type: 'object',
    properties: {
      token: { type: 'string', 'x-secret': true },
      nested: { type: 'object', properties: { key: { type: 'string', 'x-secret': true } } },
      url: { type: 'string' },
    },
  };
  const notifier = {
    id: 'n',
    displayName: 'N',
    settingsSchema,
    create: () => ({
      send: () => Promise.resolve(),
      health: () => Promise.resolve({ status: 'unknown' as const, checkedAt: '' }),
    }),
  };

  it.each([
    ['no secret fields and none listed', {}, [], undefined],
    ['x-secret fields', {}, [notifier], ['nested.key', 'token']],
    [
      'a listed name plus fields, deduplicated',
      { secrets: ['token', 'extra'] },
      [notifier],
      ['extra', 'nested.key', 'token'],
    ],
  ])('%s', (_label, capabilities, notifiers, expected) => {
    const plugin = definePlugin({
      id: 'p',
      displayName: 'P',
      capabilities: { network: [], ...capabilities },
      notifiers,
    });
    expect(plugin.capabilities.secrets).toEqual(expected);
    expect(plugin.capabilities.network).toEqual([]);
  });
});

describe('error guards', () => {
  it.each([
    [isCapabilityError, new CapabilityError('x'), true],
    [isCapabilityError, new Error('x'), false],
    [isSecretNotFoundError, new SecretNotFoundError('x'), true],
    [isSecretNotFoundError, Object.assign(new Error('x'), { name: 'SecretNotFoundError' }), true],
    [isSecretNotFoundError, { name: 'SecretNotFoundError' }, false],
  ])('%o(%o) is %s', (guard, err, expected) => {
    expect(guard(err)).toBe(expected);
  });
});
