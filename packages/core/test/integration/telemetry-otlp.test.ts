import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { definePlugin, safeEqual, type PluginDefinition } from '@ai-switchboard/sdk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSwitchboard, type Switchboard } from '../../src/app.js';
import { FakeClock } from '../../src/clock.js';
import { testConfig } from '../../src/config.js';
import { destinations, processes, runs, sources } from '../../src/db/schema.js';
import { defaultProcessDocument } from '../../src/domain/process.js';
import { createLogger } from '../../src/logger.js';
import { MemoryQueue } from '../../src/queue/queue.js';
import { parseOtelConfig } from '../../src/telemetry/otel-config.js';
import { setupTelemetry, type TelemetryRuntime } from '../../src/telemetry/setup.js';
import { createTelemetry } from '../../src/telemetry/telemetry.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

// Exports http/json, for readable assertions.

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes?: { key: string; value: Record<string, unknown> }[];
  links?: { traceId: string; spanId: string }[];
}
interface OtlpLog {
  traceId?: string;
  spanId?: string;
  severityText?: string;
  body?: { stringValue?: string };
  attributes?: { key: string; value: Record<string, unknown> }[];
}

const received: Record<string, unknown[]> = {};
const backendCalls: IncomingMessage['headers'][] = [];
let server: Server;
let receiverUrl: string;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const SENDER_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SENDER_SPAN = '00f067aa0ba902b7';

const plugin: PluginDefinition = definePlugin({
  id: 'otel-test',
  displayName: 'OTel test plugin',
  sources: [
    {
      id: 'otel-hook',
      displayName: 'OTel hook',
      mode: 'push',
      settingsSchema: { type: 'object' },
      eventTypes: [
        {
          type: 'otel-hook.item',
          title: 'Item',
          description: 'An item',
          attributes: { type: 'object', properties: { label: { type: 'string' } } },
          examples: [{ label: 'x' }],
        },
      ],
      create: (_settings, ctx) => ({
        verify: (req) =>
          safeEqual(req.headers['x-secret'], 'fixture-secret')
            ? { ok: true }
            : { ok: false, reason: 'bad secret' },
        parse: (req) => {
          const b = JSON.parse(req.body.toString('utf8')) as { id: string };
          return [
            {
              type: 'otel-hook.item',
              occurredAt: ctx.now().toISOString(),
              artifact: { kind: 'item', id: b.id },
              attributes: { label: 'go' },
              dedupeKey: `item:${b.id}`,
            },
          ];
        },
        health: () => Promise.resolve({ status: 'healthy', checkedAt: ctx.now().toISOString() }),
      }),
    },
  ],
  destinations: [
    {
      id: 'otel-dest',
      displayName: 'OTel destination',
      settingsSchema: { type: 'object', properties: { url: { type: 'string' } } },
      targetSchema: { type: 'object' },
      inputSchema: { type: 'object' },
      examples: [{ target: {}, input: {} }],
      tracking: 'sync',
      idempotentInvoke: false,
      usage: [],
      create: (settings, ctx) => ({
        invoke: async (_target, input) => {
          const res = await ctx.http.post(String(settings.url), { json: input });
          return res.ok
            ? { status: 'completed', result: { ok: true } }
            : { status: 'failed', errors: [`backend ${res.status}`] };
        },
        health: () => Promise.resolve({ status: 'healthy', checkedAt: ctx.now().toISOString() }),
      }),
    },
  ],
});

let tdb: TestDatabase;
let sb: Switchboard;
let runtime: TelemetryRuntime;
let queue: MemoryQueue;
let sourceId: string;
let processId: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void body(req).then((text) => {
      const path = req.url ?? '';
      if (path === '/backend') {
        backendCalls.push(req.headers);
      } else {
        (received[path] ??= []).push(JSON.parse(text));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  tdb = await createTestDatabase();
  const clock = new FakeClock('2026-01-05T09:00:00Z');
  sourceId = randomUUID();
  const destinationId = randomUUID();
  await tdb.db.insert(sources).values({
    id: sourceId,
    typeId: 'otel-hook',
    name: 'Hook',
    createdAt: clock.now(),
  });
  await tdb.db.insert(destinations).values({
    id: destinationId,
    typeId: 'otel-dest',
    name: 'Backend',
    settings: { url: `${receiverUrl}/backend` },
  });
  const doc = defaultProcessDocument('Traced', destinationId);
  const [proc] = await tdb.db
    .insert(processes)
    .values({
      name: doc.name,
      enabled: true,
      document: {
        ...doc,
        enabled: true,
        triggers: [
          {
            id: 't1',
            sourceId,
            eventTypes: ['otel-hook.item'],
            describe: 'every item',
            enabled: true,
          },
        ],
        // One event closes the batch: dispatch follows the match job directly.
        batching: { debounceSeconds: 0, maxSize: 1, maxAgeSeconds: 60 },
      },
      createdAt: clock.now(),
      updatedAt: clock.now(),
    })
    .returning({ id: processes.id });
  processId = proc?.id ?? '';

  const config = testConfig({
    host: '127.0.0.1',
    port: 0,
    telemetry: parseOtelConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: receiverUrl,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=fixture-secret-key',
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=test',
      OTEL_METRIC_EXPORT_INTERVAL: '60000',
      SWITCHBOARD_PROMETHEUS: 'false',
    }),
  });
  // Lines go to the OTel bridge only (not the test output).
  const logger = createLogger({
    level: 'info',
    exportLogs: true,
    destination: { write: () => undefined },
  });
  runtime = setupTelemetry(config, logger);
  queue = new MemoryQueue(clock);
  sb = await createSwitchboard({
    config,
    logger,
    clock,
    queue,
    database: tdb,
    telemetry: createTelemetry(logger),
    telemetryRuntime: runtime,
    plugins: {
      builtin: [{ name: 'otel-test', version: '1.0.0', definition: plugin }],
      scanDirs: [],
    },
    adminPassword: 'fixture-admin-password',
  });
  await sb.start();
}, 120_000);

afterAll(async () => {
  await sb.stop();
  await tdb.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const allSpans = (): OtlpSpan[] =>
  (received['/v1/traces'] ?? []).flatMap((r) =>
    (r as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] }).resourceSpans.flatMap(
      (rs) => rs.scopeSpans.flatMap((ss) => ss.spans),
    ),
  );
const allLogs = (): OtlpLog[] =>
  (received['/v1/logs'] ?? []).flatMap((r) =>
    (r as { resourceLogs: { scopeLogs: { logRecords: OtlpLog[] }[] }[] }).resourceLogs.flatMap(
      (rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords),
    ),
  );
const attr = (x: { attributes?: OtlpSpan['attributes'] }, key: string): unknown => {
  const v = x.attributes?.find((a) => a.key === key)?.value;
  return v ? Object.values(v)[0] : undefined;
};

describe('telemetry over OTLP', () => {
  it('one webhook reads as one trace, with logs and metrics', async () => {
    const res = await sb.app.inject({
      method: 'POST',
      url: `/hooks/${sourceId}`,
      headers: {
        'content-type': 'application/json',
        'x-secret': 'fixture-secret',
        traceparent: `00-${SENDER_TRACE}-${SENDER_SPAN}-01`,
      },
      payload: JSON.stringify({ id: 'item-1' }),
    });
    expect(res.statusCode).toBe(200);
    await queue.drain();
    const [run] = await tdb.db.select().from(runs).where(eq(runs.processId, processId));
    expect(run?.status).toBe('ok');
    expect(run?.traceContext).toMatch(new RegExp(`^00-${SENDER_TRACE}-[0-9a-f]{16}-01$`));
    await runtime.flush();

    const spans = allSpans();
    const one = (name: string, pred: (s: OtlpSpan) => boolean = () => true): OtlpSpan => {
      const found = spans.filter((s) => s.name === name && pred(s));
      expect(found, `${name} in ${spans.map((s) => s.name).join(', ')}`).toHaveLength(1);
      return found[0]!;
    };
    const childOf = (parent: OtlpSpan) => (s: OtlpSpan) => s.parentSpanId === parent.spanId;

    const http = one('POST /hooks/:sourceId');
    expect(http.traceId).toBe(SENDER_TRACE);
    expect(http.parentSpanId).toBe(SENDER_SPAN);
    expect(http.kind).toBe(2); // SERVER
    expect(attr(http, 'http.response.status_code')).toBe(200);
    expect(attr(http, 'http.route')).toBe('/hooks/:sourceId');

    const ingest = one('switchboard.ingest', childOf(http));
    one('switchboard.plugin.verify', childOf(ingest));
    one('switchboard.plugin.parse', childOf(ingest));
    expect(attr(ingest, 'switchboard.events.count')).toBe(1);

    const matchJob = one('process pipeline.match', childOf(ingest));
    expect(matchJob.kind).toBe(5); // CONSUMER
    const match = one('switchboard.match', childOf(matchJob));
    const dispatchJob = one('process pipeline.dispatch', childOf(match));
    const dispatch = one('switchboard.dispatch', childOf(dispatchJob));
    expect(dispatch.links?.map((l) => l.spanId)).toEqual([ingest.spanId]);
    expect(attr(dispatch, 'switchboard.outcome')).toBe('ok');
    expect(run?.traceContext).toContain(dispatch.spanId);
    one('switchboard.gate', childOf(dispatch));
    one('switchboard.budget', childOf(dispatch));
    const invoke = one('switchboard.invoke', childOf(dispatch));
    const pluginInvoke = one('switchboard.plugin.invoke', childOf(invoke));
    expect(attr(pluginInvoke, 'plugin')).toBe('otel-test');
    const client = one('POST', childOf(pluginInvoke));
    expect(client.kind).toBe(3); // CLIENT
    expect(backendCalls).toHaveLength(1);
    expect(backendCalls[0]?.traceparent).toBe(`00-${SENDER_TRACE}-${client.spanId}-01`);
    one('process pipeline.finish');

    for (const s of [ingest, matchJob, match, dispatch, invoke, pluginInvoke, client]) {
      expect(s.traceId, s.name).toBe(SENDER_TRACE);
    }

    const logs = allLogs();
    const decision = logs.find(
      (l) => l.body?.stringValue === 'switchboard.runs' && attr(l, 'status') === 'ok',
    );
    expect(decision?.traceId).toBe(SENDER_TRACE);
    expect(attr(decision ?? {}, 'run_id')).toBe(run?.id);
    expect(attr(decision ?? {}, 'component')).toBe('pipeline');
    const receivedLine = logs.find(
      (l) => l.body?.stringValue === 'switchboard.events' && attr(l, 'stage') === 'received',
    );
    expect(receivedLine?.traceId).toBe(SENDER_TRACE);
    expect(receivedLine?.spanId).toBe(ingest.spanId);
    // The exporter's API key never shows up in anything exported.
    expect(JSON.stringify(logs)).not.toContain('fixture-secret-key');

    const metricBatches = (received['/v1/metrics'] ?? []) as {
      resourceMetrics: {
        resource: { attributes: { key: string; value: Record<string, unknown> }[] };
        scopeMetrics: { metrics: { name: string }[] }[];
      }[];
    }[];
    const names = new Set(
      metricBatches.flatMap((b) =>
        b.resourceMetrics.flatMap((rm) =>
          rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.name)),
        ),
      ),
    );
    for (const n of [
      'switchboard.events',
      'switchboard.dispatches',
      'switchboard.batches',
      'switchboard.runs',
      'switchboard.run.duration',
      'http.server.request.duration',
    ]) {
      expect(names, n).toContain(n);
    }
    const resource = metricBatches[0]?.resourceMetrics[0]?.resource;
    expect(attr(resource ?? {}, 'service.name')).toBe('switchboard');
    expect(attr(resource ?? {}, 'service.instance.id')).toBe('test-replica');
    expect(attr(resource ?? {}, 'deployment.environment.name')).toBe('test');
  });

  it('Settings › About reports where telemetry goes, never the header values', async () => {
    const login = await sb.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@switchboard.local', password: 'fixture-admin-password' },
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await sb.app.inject({ method: 'GET', url: '/api/v1/about', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('fixture-secret-key');
    expect(res.body).not.toContain('x-api-key');
    const about = res.json<{ telemetry: { signals: { signal: string; endpoint: string }[] } }>();
    expect(about.telemetry.signals.map((s) => [s.signal, s.endpoint])).toEqual([
      ['traces', receiverUrl],
      ['metrics', receiverUrl],
      ['logs', receiverUrl],
    ]);
  });
});
