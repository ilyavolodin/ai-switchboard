import { createServer, type IncomingMessage } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyHmac } from '@ai-switchboard/sdk';

import { createStubServer, type StubServer } from '../../../deploy/stub/server.js';

/** A tiny receiver standing in for Switchboard's /hooks and /callbacks routes. */
interface Received {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

async function receiver(): Promise<{ url: string; got: Received[]; close: () => Promise<void> }> {
  const got: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      got.push({
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    got,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

let stub: StubServer;
let base: string;

beforeEach(async () => {
  stub = createStubServer({ env: {}, callbackSecret: 'fixture-secret' });
  base = (await stub.listen(0, '127.0.0.1')).url;
});

afterEach(async () => {
  await stub.close();
});

describe('stub server: http executor target', () => {
  it('echoes the body with usage', async () => {
    const res = await fetch(`${base}/exec?cost=0.5`, {
      method: 'POST',
      body: JSON.stringify({ runId: 'r1', mode: 'event' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      echo: { runId: 'r1', mode: 'event' },
      usage: { cost_usd: 0.5 },
    });
  });

  it('returns the status asked for by header', async () => {
    const res = await fetch(`${base}/exec`, {
      method: 'POST',
      headers: { 'x-stub-status': '503' },
      body: '{}',
    });
    expect(res.status).toBe(503);
  });

  it('posts a signed callback to x-switchboard-callback-url', async () => {
    const rx = await receiver();
    try {
      const res = await fetch(`${base}/exec/callback?delay=10`, {
        method: 'POST',
        headers: {
          'x-switchboard-callback-url': `${rx.url}/callbacks/exec-1`,
          'x-switchboard-run-id': 'run-42',
        },
        body: '{}',
      });
      expect(res.status).toBe(202);
      await stub.settled();
      const cb = rx.got[0];
      expect(cb?.path).toBe('/callbacks/exec-1');
      expect(JSON.parse(cb?.body ?? '{}')).toMatchObject({ runId: 'run-42', status: 'ok' });
      const signature = cb?.headers['x-switchboard-signature'];
      expect(
        verifyHmac({
          secret: 'fixture-secret',
          payload: cb?.body ?? '',
          signature: typeof signature === 'string' ? signature : undefined,
          prefix: 'sha256=',
        }),
      ).toBe(true);
    } finally {
      await rx.close();
    }
  });
});

describe('stub server: webhook sender', () => {
  it('signs and sends one event', async () => {
    const rx = await receiver();
    try {
      const res = await fetch(`${base}/send?target=${rx.url}/hooks/src-1&secret=whsec`, {
        method: 'POST',
      });
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
      const hook = rx.got[0];
      const signature = hook?.headers['x-signature-256'];
      expect(
        verifyHmac({
          secret: 'whsec',
          payload: hook?.body ?? '',
          signature: typeof signature === 'string' ? signature : undefined,
          prefix: 'sha256=',
        }),
      ).toBe(true);
    } finally {
      await rx.close();
    }
  });

  it('bursts n events across keys', async () => {
    const rx = await receiver();
    try {
      const res = await fetch(`${base}/burst?n=25&keys=5&target=${rx.url}/hooks/src-1`, {
        method: 'POST',
      });
      expect(await res.json()).toMatchObject({ sent: 25, statuses: { 200: 25 } });
      const services = new Set(
        rx.got.map((r) => (JSON.parse(r.body) as { service: string }).service),
      );
      expect(services.size).toBe(5);
    } finally {
      await rx.close();
    }
  });
});

describe('stub server: fake Claude Routines', () => {
  it('fires a routine and returns a session', async () => {
    const res = await fetch(`${base}/v1/claude_code/routines/rt_1/fire`, {
      method: 'POST',
      body: JSON.stringify({ text: 'run r1' }),
    });
    const body = (await res.json()) as { id: string; session_url: string };
    expect(res.status).toBe(200);
    expect(body.session_url).toContain(body.id);
  });

  it('answers every Nth fire with 429 and retry-after', async () => {
    await fetch(`${base}/stub/config`, {
      method: 'POST',
      body: JSON.stringify({ routines429Every: 2, retryAfterSeconds: 30 }),
    });
    const fire = (): Promise<Response> =>
      fetch(`${base}/v1/claude_code/routines/rt_1/fire`, { method: 'POST', body: '{}' });
    expect((await fire()).status).toBe(200);
    const limited = await fire();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
  });

  it('reports usage windows and issues tokens', async () => {
    const usage = (await (await fetch(`${base}/api/oauth/usage`)).json()) as Record<
      string,
      { utilization: number }
    >;
    expect(usage.five_hour?.utilization).toBe(42);
    expect(usage.seven_day?.utilization).toBe(17);
    const token = (await (
      await fetch(`${base}/v1/oauth/token`, { method: 'POST', body: '{}' })
    ).json()) as { access_token: string; refresh_token: string };
    expect(token.access_token).toMatch(/^stub-access-/);
    expect(token.refresh_token).toMatch(/^stub-refresh-/);
  });
});

describe('stub server: http executor meter', () => {
  it('reports { used, limit, resetsAt } for a meterEndpoint', async () => {
    const reading = (await (await fetch(`${base}/meter`)).json()) as {
      used: number;
      limit: number;
      resetsAt: string;
    };
    expect(reading).toMatchObject({ used: 30, limit: 100 });
    expect(Date.parse(reading.resetsAt)).toBeGreaterThan(Date.now());
  });
});

describe('stub server: request recorder', () => {
  it('records requests and resets on DELETE', async () => {
    await fetch(`${base}/exec`, { method: 'POST', body: '{"a":1}' });
    const listed = (await (await fetch(`${base}/requests`)).json()) as {
      requests: { method: string; path: string; body: unknown }[];
    };
    expect(listed.requests).toEqual([
      expect.objectContaining({ method: 'POST', path: '/exec', body: { a: 1 } }),
    ]);
    expect((await fetch(`${base}/requests`, { method: 'DELETE' })).status).toBe(204);
    expect(stub.requests).toHaveLength(0);
  });
});
