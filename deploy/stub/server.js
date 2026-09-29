// Dependency-free integration stub that plays every external system the integration and e2e
// suites need: an `http` destination target and meter, a webhook sender, a fake Claude Routines
// API and a request recorder. Must stay dependency-free: the image copies only this file.

import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_RECORDED = 5000;

export function sign(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(buf) {
  if (buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return buf.toString('utf8');
  }
}

function send(res, status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  });
  res.end(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Options override the environment. */
export function createStubServer(options = {}) {
  const env = options.env ?? process.env;
  const config = {
    callbackSecret: options.callbackSecret ?? env.STUB_CALLBACK_SECRET ?? 'stub-callback-secret',
    routines429: options.routines429 ?? env.STUB_ROUTINES_429 === '1',
    routines429Every: options.routines429Every ?? num(env.STUB_ROUTINES_429_EVERY, 0),
    retryAfterSeconds: options.retryAfterSeconds ?? num(env.STUB_RETRY_AFTER, 60),
    fiveHour: options.fiveHour ?? num(env.STUB_FIVE_HOUR, 42),
    sevenDay: options.sevenDay ?? num(env.STUB_SEVEN_DAY, 17),
    meterUsed: options.meterUsed ?? num(env.STUB_METER_USED, 30),
    meterLimit: options.meterLimit ?? num(env.STUB_METER_LIMIT, 100),
  };
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());
  const requests = [];
  const outbound = [];
  let fireCount = 0;
  const pending = new Set();

  async function post(url, body, headers) {
    const record = { at: now().toISOString(), url, headers, body: parseJson(Buffer.from(body)) };
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      record.status = res.status;
    } catch (err) {
      record.status = 0;
      record.error = err instanceof Error ? err.message : String(err);
    }
    outbound.push(record);
    return record;
  }

  function sampleEvent(i, keys, type) {
    const service = `service-${(i % Math.max(1, keys)) + 1}`;
    return {
      id: randomUUID(),
      type,
      service,
      severity: i % 5 === 0 ? 'critical' : 'warning',
      message: `Stub alert ${i + 1} for ${service}`,
      occurredAt: now().toISOString(),
    };
  }

  async function sendSigned(target, secret, header, event) {
    const body = JSON.stringify(event);
    const headers = { 'x-stub-delivery': event.id };
    if (secret) headers[header] = sign(secret, body);
    return post(target, body, headers);
  }

  const routes = {
    async 'POST /exec'(req, res, url, body) {
      const status = num(req.headers['x-stub-status'] ?? url.searchParams.get('status'), 200);
      const latency = num(req.headers['x-stub-latency-ms'] ?? url.searchParams.get('latency'), 0);
      const cost = num(url.searchParams.get('cost'), 0.01);
      if (latency > 0) await sleep(latency);
      if (status >= 400) {
        send(res, status, { ok: false, error: `stub status ${status}` });
        return;
      }
      send(res, status, { ok: true, echo: parseJson(body), usage: { cost_usd: cost } });
    },

    async 'POST /exec/callback'(req, res, url, body) {
      const parsed = parseJson(body);
      const callbackUrl =
        req.headers['x-switchboard-callback-url'] ?? url.searchParams.get('callbackUrl');
      const runId =
        req.headers['x-switchboard-run-id'] ??
        (parsed && typeof parsed === 'object' ? parsed.runId : undefined);
      if (!callbackUrl || !runId) {
        send(res, 400, {
          ok: false,
          error:
            'x-switchboard-callback-url header and a run id (x-switchboard-run-id or body.runId) are required',
        });
        return;
      }
      const delay = num(url.searchParams.get('delay'), 500);
      const outcome = url.searchParams.get('outcome') === 'error' ? 'error' : 'ok';
      const cost = num(url.searchParams.get('cost'), 0.01);
      const id = `stub-${randomUUID()}`;
      send(res, 202, { accepted: true, id });
      const task = (async () => {
        await sleep(delay);
        const payload = JSON.stringify({
          runId,
          externalId: id,
          status: outcome,
          ...(outcome === 'error' ? { errors: ['stub reported an error'] } : {}),
          usage: { cost_usd: cost },
          finishedAt: now().toISOString(),
        });
        await post(String(callbackUrl), payload, {
          'x-switchboard-signature': sign(config.callbackSecret, payload),
        });
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },

    async 'POST /send'(_req, res, url) {
      const target = url.searchParams.get('target');
      if (!target) {
        send(res, 400, { ok: false, error: 'target is required' });
        return;
      }
      const event = sampleEvent(0, 1, url.searchParams.get('type') ?? 'alert.fired');
      const severity = url.searchParams.get('severity');
      if (severity) event.severity = severity;
      const record = await sendSigned(
        target,
        url.searchParams.get('secret') ?? '',
        url.searchParams.get('header') ?? 'x-signature-256',
        event,
      );
      send(res, 200, {
        ok: record.status >= 200 && record.status < 300,
        status: record.status,
        event,
      });
    },

    async 'POST /burst'(_req, res, url) {
      const target = url.searchParams.get('target');
      if (!target) {
        send(res, 400, { ok: false, error: 'target is required' });
        return;
      }
      const n = Math.min(num(url.searchParams.get('n'), 500), 10_000);
      const keys = num(url.searchParams.get('keys'), 5);
      const secret = url.searchParams.get('secret') ?? '';
      const header = url.searchParams.get('header') ?? 'x-signature-256';
      const type = url.searchParams.get('type') ?? 'alert.fired';
      const concurrency = num(url.searchParams.get('concurrency'), 20);
      const statuses = {};
      let next = 0;
      const worker = async () => {
        while (next < n) {
          const i = next++;
          const record = await sendSigned(target, secret, header, sampleEvent(i, keys, type));
          statuses[record.status] = (statuses[record.status] ?? 0) + 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));
      send(res, 200, { ok: true, sent: n, statuses });
    },

    async 'POST /stub/config'(_req, res, _url, body) {
      const patch = parseJson(body);
      if (patch && typeof patch === 'object') {
        for (const key of Object.keys(config)) if (key in patch) config[key] = patch[key];
      }
      send(res, 200, { ...config, callbackSecret: undefined });
    },

    async 'GET /api/oauth/usage'(_req, res) {
      const t = now().getTime();
      send(res, 200, {
        five_hour: {
          utilization: config.fiveHour,
          resets_at: new Date(t + 2 * 3_600_000).toISOString(),
        },
        seven_day: {
          utilization: config.sevenDay,
          resets_at: new Date(t + 3 * 86_400_000).toISOString(),
        },
      });
    },

    async 'GET /meter'(_req, res) {
      send(res, 200, {
        used: config.meterUsed,
        limit: config.meterLimit,
        resetsAt: new Date(now().getTime() + 2 * 3_600_000).toISOString(),
      });
    },

    async 'POST /v1/oauth/token'(_req, res) {
      send(res, 200, {
        access_token: `stub-access-${randomUUID()}`,
        refresh_token: `stub-refresh-${randomUUID()}`,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    },

    async 'GET /requests'(_req, res) {
      send(res, 200, { requests, outbound });
    },

    async 'DELETE /requests'(_req, res) {
      requests.length = 0;
      outbound.length = 0;
      fireCount = 0;
      send(res, 204);
    },

    async 'GET /healthz'(_req, res) {
      send(res, 200, { ok: true });
    },
  };

  async function fireRoutine(res, routineId) {
    fireCount += 1;
    const every = config.routines429Every;
    if (config.routines429 || (every > 0 && fireCount % every === 0)) {
      send(
        res,
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: 'stub: rate limited' } },
        { 'retry-after': String(config.retryAfterSeconds) },
      );
      return;
    }
    const id = `session_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    send(res, 200, {
      id,
      routine_id: routineId,
      session_url: `https://claude.ai/code/${id}`,
    });
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub.local');
      const body = await readBody(req);
      if (url.pathname !== '/requests' && url.pathname !== '/healthz') {
        requests.push({
          at: now().toISOString(),
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          body: parseJson(body),
        });
        if (requests.length > MAX_RECORDED) requests.shift();
      }
      const fire = /^\/v1\/claude_code\/routines\/([^/]+)\/fire$/.exec(url.pathname);
      if (req.method === 'POST' && fire) {
        await fireRoutine(res, decodeURIComponent(fire[1]));
        return;
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) {
        send(res, 404, { ok: false, error: `no stub route for ${req.method} ${url.pathname}` });
        return;
      }
      await handler(req, res, url, body);
    })().catch((err) => {
      if (!res.headersSent) send(res, 500, { ok: false, error: String(err) });
    });
  });

  return {
    server,
    config,
    requests,
    outbound,
    settled: () => Promise.all([...pending]),
    listen(port = num(env.STUB_PORT, 9090), host = '0.0.0.0') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const address = server.address();
          const actual = typeof address === 'object' && address ? address.port : port;
          resolve({ port: actual, url: `http://127.0.0.1:${actual}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const stub = createStubServer();
  const { port } = await stub.listen();
  process.stdout.write(`switchboard stub listening on :${port}\n`);
  const stop = () => {
    void stub.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
