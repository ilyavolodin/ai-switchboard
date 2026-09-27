import { describe, expect, it } from 'vitest';

import {
  isInvokeError,
  isTransportError,
  signHmac,
  type Executor,
  type Settings,
} from '@ai-switchboard/sdk';
import {
  createStubHttp,
  createTestContext,
  executorConformanceChecks,
  pluginConformanceChecks,
  rawRequest,
  runConformance,
  runHandle,
  type StubHandler,
  type StubRequest,
} from '@ai-switchboard/sdk/testing';

import plugin, { httpExecutorType } from './plugin.js';

const SECRET = 'fixture-secret-callback-0001';
const AUTH = 'Bearer fixture-secret-token';
const START = Date.parse('2026-09-27T10:00:00.000Z');

const settings: Settings = {
  baseUrl: 'https://jobs.example.com/api',
  headers: { authorization: AUTH, 'X-Team': 'platform' },
  callbackSecret: SECRET,
  meterEndpoint: '/capacity',
};

function setup(
  handler: StubHandler,
  overrides: Settings = {},
): { executor: Executor; calls: StubRequest[]; ctx: ReturnType<typeof createTestContext> } {
  let t = START;
  const stub = createStubHttp((req) => {
    // Every backend call takes 1.5 s of fake time.
    t += 1500;
    return handler(req);
  });
  const ctx = createTestContext({ http: stub.client, now: () => new Date(t) });
  return {
    executor: httpExecutorType.create({ ...settings, ...overrides }, ctx),
    calls: stub.calls,
    ctx,
  };
}

async function invokeError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected invoke to throw');
}

function signed(body: unknown, secret = SECRET): ReturnType<typeof rawRequest> {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return rawRequest({
    path: '/callbacks/test-instance',
    headers: { 'x-switchboard-signature': `sha256=${signHmac({ secret, payload: text })}` },
    body: text,
  });
}

runConformance('plugin', pluginConformanceChecks(plugin), { describe, it });

runConformance(
  'http executor',
  executorConformanceChecks(httpExecutorType, {
    settings,
    http: (req) =>
      req.url.pathname.endsWith('/capacity')
        ? { json: { used: 30, limit: 120, resetsAt: '2026-09-27T11:00:00Z' } }
        : { json: { ok: true } },
    unsignedCallback: rawRequest({ body: { runId: 'r1', status: 'ok' } }),
  }),
  { describe, it },
);

describe('http executor: invoke', () => {
  it('sync 2xx completes with the parsed body and measured usage', async () => {
    const { executor, calls } = setup(() => ({ json: { summary: 'done', cost: 0.25 } }));
    const result = await executor.invoke(
      { url: 'https://jobs.example.com/api/triage' },
      { issue: 42 },
      runHandle({ id: 'run-1' }),
    );
    expect(result.status).toBe('completed');
    expect(result.result).toEqual({ summary: 'done', cost: 0.25 });
    expect(result.usage).toEqual({
      duration_seconds: 1.5,
      response_bytes: Buffer.byteLength('{"summary":"done","cost":0.25}'),
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.json()).toEqual({ issue: 42 });
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('returns a text result when the body is not JSON', async () => {
    const { executor } = setup(() => ({ body: 'queued fine' }));
    const result = await executor.invoke({ url: '/x' }, {}, runHandle());
    expect(result).toMatchObject({ status: 'completed', result: 'queued fine' });
  });

  it('sends the run id and callback url, and the dry-run header only on dry runs', async () => {
    const { executor, calls } = setup(() => ({ json: {} }));
    const run = runHandle({ id: 'run-7', callbackUrl: 'https://sb.test/callbacks/i1' });
    await executor.invoke({ url: '/x' }, {}, run);
    await executor.invoke({ url: '/x' }, {}, { ...run, dryRun: true });
    expect(calls[0]?.headers['x-switchboard-run-id']).toBe('run-7');
    expect(calls[0]?.headers['x-switchboard-callback-url']).toBe('https://sb.test/callbacks/i1');
    expect(calls[0]?.headers['x-switchboard-dry-run']).toBeUndefined();
    expect(calls[1]?.headers['x-switchboard-dry-run']).toBe('1');
  });

  it('resolves relative urls against the base url and merges headers', async () => {
    const { executor, calls } = setup(() => ({ json: {} }));
    await executor.invoke(
      { url: '/jobs/run', headers: { 'X-Team': 'ops', 'x-extra': '1' } },
      {},
      runHandle(),
    );
    expect(calls[0]?.url.toString()).toBe('https://jobs.example.com/api/jobs/run');
    expect(calls[0]?.headers.authorization).toBe(AUTH);
    expect(calls[0]?.headers['x-team']).toBe('ops');
    expect(calls[0]?.headers['x-extra']).toBe('1');
  });

  it('never sends the default headers (and the authorization secret) to another origin', async () => {
    const { executor, calls } = setup(() => ({ json: {} }));
    await executor.invoke({ url: 'https://elsewhere.example.net/hook' }, {}, runHandle());
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(calls[0]?.headers['x-team']).toBeUndefined();
    expect(calls[0]?.headers['x-switchboard-run-id']).toBeDefined();
  });

  it('a relative url without a base url is a definitive failure', async () => {
    const { executor, calls } = setup(() => ({ json: {} }), { baseUrl: undefined });
    const err = await invokeError(executor.invoke({ url: '/x' }, {}, runHandle()));
    expect(isInvokeError(err) && err.definitive).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('an invalid target is a definitive failure', async () => {
    const { executor } = setup(() => ({ json: {} }));
    const err = await invokeError(
      executor.invoke({ url: '/x', tracking: 'poll' }, {}, runHandle()),
    );
    expect(isInvokeError(err) && err.definitive).toBe(true);
  });

  it('GET sends no body', async () => {
    const { executor, calls } = setup(() => ({ json: {} }));
    await executor.invoke({ method: 'GET', url: '/status' }, { ignored: true }, runHandle());
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.body).toBe('');
  });

  it('usageFrom adds declared dimensions and drops undeclared ones', async () => {
    const { executor } = setup(() => ({ json: { cost: 0.4, tokens: 900 } }), {
      usageDimensions: [
        {
          id: 'duration_seconds',
          title: 'Duration',
          unit: 'seconds',
          aggregate: 'sum',
          budgetable: true,
        },
        { id: 'cost_usd', title: 'Cost', unit: 'usd', aggregate: 'sum', budgetable: true },
      ],
    });
    const result = await executor.invoke(
      {
        url: '/x',
        usageFrom:
          '{ "cost_usd": response.body.cost, "tokens": response.body.tokens, "status": response.status }',
      },
      {},
      runHandle(),
    );
    expect(result.usage).toEqual({ duration_seconds: 1.5, cost_usd: 0.4 });
  });

  it('a broken usageFrom keeps the measured usage and logs a warning', async () => {
    const { executor, ctx } = setup(() => ({ json: { cost: 1 } }));
    const result = await executor.invoke(
      { url: '/x', usageFrom: '"not an object"' },
      {},
      runHandle(),
    );
    expect(result.status).toBe('completed');
    expect(result.usage).toEqual({ duration_seconds: 1.5, response_bytes: 10 });
    expect(ctx.logs.some((l) => l.level === 'warn' && l.message.includes('usageFrom'))).toBe(true);
  });

  it('a usageFrom that never ends is cut off by the time limit', async () => {
    const { executor, ctx } = setup(() => ({ json: { cost: 1 } }));
    const result = await executor.invoke(
      { url: '/x', usageFrom: '($loop := function($n) { $loop($n + 1) }; $loop(0))' },
      {},
      runHandle(),
    );
    expect(result.status).toBe('completed');
    expect(ctx.logs.some((l) => l.level === 'warn' && l.message.includes('usageFrom'))).toBe(true);
  }, 10_000);

  it('callback tracking returns started with the external id', async () => {
    const { executor } = setup(() => ({ status: 202, json: { requestId: 'req-9' } }));
    const result = await executor.invoke({ url: '/x', tracking: 'callback' }, {}, runHandle());
    expect(result).toEqual({ status: 'started', externalId: 'req-9' });
  });

  it('none tracking returns started on 2xx', async () => {
    const { executor } = setup(() => ({ status: 204 }));
    const result = await executor.invoke({ url: '/x', tracking: 'none' }, {}, runHandle());
    expect(result).toEqual({ status: 'started' });
  });

  it('429 returns failed with retryAfterSeconds from the header', async () => {
    const { executor } = setup(() => ({ status: 429, headers: { 'retry-after': '120' } }));
    const result = await executor.invoke({ url: '/x' }, {}, runHandle());
    expect(result.status).toBe('failed');
    expect(result.retryAfterSeconds).toBe(120);
  });

  it('429 without retry-after defaults to 60 seconds', async () => {
    const { executor } = setup(() => ({ status: 429 }));
    const result = await executor.invoke({ url: '/x', tracking: 'callback' }, {}, runHandle());
    expect(result).toMatchObject({ status: 'failed', retryAfterSeconds: 60 });
  });

  it('423 Locked is held: paused', async () => {
    const { executor } = setup(() => ({ status: 423, body: 'paused' }));
    const result = await executor.invoke({ url: '/x' }, {}, runHandle());
    expect(result).toEqual({ status: 'held', reason: 'paused' });
  });

  it.each([
    [503, false, 503],
    [400, true, 400],
    [401, true, 401],
    [404, true, 404],
    [422, true, 422],
    [500, false, 500],
    [502, false, 502],
  ])('%i maps to InvokeError definitive=%s', async (status, definitive, expectedStatus) => {
    const { executor } = setup(() => ({ status, body: 'nope' }));
    const err = await invokeError(executor.invoke({ url: '/x' }, {}, runHandle()));
    expect(isInvokeError(err)).toBe(true);
    if (!isInvokeError(err)) return;
    expect(err.definitive).toBe(definitive);
    expect(err.status).toBe(expectedStatus);
    expect(err.message).toContain('nope');
  });

  it('lets TransportError through with sent=false when the connection is refused', async () => {
    const { executor } = setup(() => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    });
    const err = await invokeError(executor.invoke({ url: '/x' }, {}, runHandle()));
    expect(isTransportError(err) && err.sent).toBe(false);
  });

  it('lets TransportError through with sent=true when the connection resets', async () => {
    const { executor } = setup(() => {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    });
    const err = await invokeError(executor.invoke({ url: '/x' }, {}, runHandle()));
    expect(isTransportError(err) && err.sent).toBe(true);
  });
});

describe('http executor: tracking and idempotency per target', () => {
  it('defaults to sync and not idempotent', () => {
    expect(httpExecutorType.trackingFor?.({ url: '/x' })).toBe('sync');
    expect(httpExecutorType.idempotentFor?.({ url: '/x' })).toBe(false);
  });

  it('follows the target', () => {
    const target = { url: '/x', tracking: 'callback', idempotent: true };
    expect(httpExecutorType.trackingFor?.(target)).toBe('callback');
    expect(httpExecutorType.idempotentFor?.(target)).toBe(true);
    expect(httpExecutorType.trackingFor?.({ url: '/x', tracking: 'none' })).toBe('none');
  });
});

describe('http executor: verifyCallback', () => {
  const { executor } = setup(() => undefined);
  const verify = (
    req: ReturnType<typeof rawRequest>,
  ): ReturnType<NonNullable<Executor['verifyCallback']>> => executor.verifyCallback?.(req) ?? null;

  it('accepts a correctly signed callback', () => {
    const result = verify(
      signed({
        runId: 'run-1',
        status: 'ok',
        outputs: 2,
        usage: { duration_seconds: 12 },
        finishedAt: '2026-09-27T10:05:00Z',
      }),
    );
    expect(result).toEqual({
      runId: 'run-1',
      status: {
        state: 'ok',
        outputs: 2,
        usage: { duration_seconds: 12 },
        finishedAt: '2026-09-27T10:05:00Z',
      },
    });
  });

  it('maps an error callback with its errors', () => {
    const result = verify(signed({ runId: 'run-1', status: 'error', errors: ['boom'] }));
    expect(result?.status).toEqual({ state: 'error', errors: ['boom'] });
  });

  it('rejects a wrong signature', () => {
    expect(verify(signed({ runId: 'run-1', status: 'ok' }, 'fixture-secret-other-000'))).toBeNull();
  });

  it('rejects a missing signature header', () => {
    expect(verify(rawRequest({ body: { runId: 'run-1', status: 'ok' } }))).toBeNull();
  });

  it('rejects a signature without the sha256= prefix', () => {
    const body = JSON.stringify({ runId: 'run-1', status: 'ok' });
    const req = rawRequest({
      headers: { 'x-switchboard-signature': signHmac({ secret: SECRET, payload: body }) },
      body,
    });
    expect(verify(req)).toBeNull();
  });

  it('rejects malformed JSON and bodies that do not match the shape', () => {
    expect(verify(signed('{not json'))).toBeNull();
    expect(verify(signed({ runId: 'run-1', status: 'done' }))).toBeNull();
    expect(verify(signed({ status: 'ok' }))).toBeNull();
    expect(
      verify(signed({ runId: 'run-1', status: 'ok', usage: { duration_seconds: 'x' } })),
    ).toBeNull();
    expect(verify(signed([1, 2]))).toBeNull();
  });

  it('ignores unknown fields and drops undeclared usage keys', () => {
    const result = verify(
      signed({
        runId: 'run-1',
        status: 'ok',
        extra: { anything: true },
        usage: { duration_seconds: 3, bogus_tokens: 99 },
      }),
    );
    expect(result).toEqual({
      runId: 'run-1',
      status: { state: 'ok', usage: { duration_seconds: 3 } },
    });
  });

  it('rejects everything when no callback secret is configured', () => {
    const { executor: noSecret } = setup(() => undefined, { callbackSecret: undefined });
    expect(noSecret.verifyCallback?.(signed({ runId: 'run-1', status: 'ok' }))).toBeNull();
  });
});

describe('http executor: usage and meters', () => {
  it('declares the default usage dimensions and instance-specific ones', () => {
    expect(httpExecutorType.usageFor?.({}).map((d) => d.id)).toEqual([
      'duration_seconds',
      'response_bytes',
    ]);
    expect(
      httpExecutorType
        .usageFor?.({
          usageDimensions: [
            { id: 'cost_usd', title: 'Cost', unit: 'usd', aggregate: 'sum', budgetable: true },
          ],
        })
        .map((d) => d.id),
    ).toEqual(['cost_usd']);
  });

  it('declares the endpoint meter only when configured', () => {
    expect(httpExecutorType.metersFor?.({})).toEqual([]);
    expect(httpExecutorType.metersFor?.(settings)).toEqual([
      {
        id: 'endpoint',
        title: 'Endpoint capacity',
        kind: 'window',
        unit: 'requests',
        primary: true,
      },
    ]);
  });

  it('reads the meter endpoint', async () => {
    const { executor, calls } = setup(() => ({
      json: { used: 45, limit: 60, resetsAt: '2026-09-27T11:00:00Z' },
    }));
    const readings = await executor.readMeters?.();
    expect(readings).toEqual([
      {
        id: 'endpoint',
        used: 45,
        limit: 60,
        utilization: 75,
        resetsAt: '2026-09-27T11:00:00Z',
        observedAt: new Date(START + 1500).toISOString(),
      },
    ]);
    expect(calls[0]?.url.toString()).toBe('https://jobs.example.com/api/capacity');
    expect(calls[0]?.headers.authorization).toBe(AUTH);
  });

  it('clamps utilization to 100', async () => {
    const { executor } = setup(() => ({ json: { used: 90, limit: 60 } }));
    expect((await executor.readMeters?.())?.[0]?.utilization).toBe(100);
  });

  it('throws on an unusable meter response', async () => {
    const { executor } = setup(() => ({ json: { remaining: 3 } }));
    await expect(executor.readMeters?.()).rejects.toThrow(/used, limit/);
    const { executor: down } = setup(() => ({ status: 500 }));
    await expect(down.readMeters?.()).rejects.toThrow(/500/);
  });

  it('returns no readings without a meter endpoint', async () => {
    const { executor, calls } = setup(() => ({ json: {} }), { meterEndpoint: undefined });
    expect(await executor.readMeters?.()).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('http executor: health', () => {
  it('is unknown without a base url', async () => {
    const { executor } = setup(() => ({}), { baseUrl: undefined });
    expect((await executor.health()).status).toBe('unknown');
  });

  it('is healthy when the base url answers', async () => {
    const { executor, calls } = setup(() => ({ status: 200 }));
    expect((await executor.health()).status).toBe('healthy');
    expect(calls[0]?.method).toBe('HEAD');
  });

  it('falls back to GET when HEAD is not allowed', async () => {
    const { executor, calls } = setup((req) => ({ status: req.method === 'HEAD' ? 405 : 200 }));
    expect((await executor.health()).status).toBe('healthy');
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
  });

  it('is unhealthy on rejected credentials, 5xx or network failure', async () => {
    expect((await setup(() => ({ status: 401 })).executor.health()).status).toBe('unhealthy');
    expect((await setup(() => ({ status: 502 })).executor.health()).status).toBe('unhealthy');
    const down = setup(() => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    });
    expect((await down.executor.health()).status).toBe('unhealthy');
  });
});

describe('http executor: settings', () => {
  it('rejects invalid settings at create time', () => {
    expect(() => httpExecutorType.create({ baseUrl: 'not a url' }, createTestContext())).toThrow(
      /Invalid http executor settings/,
    );
  });

  it('does not mutate the settings it was given', () => {
    const given: Settings = { baseUrl: 'https://jobs.example.com' };
    httpExecutorType.create(given, createTestContext());
    expect(given).toEqual({ baseUrl: 'https://jobs.example.com' });
  });
});
