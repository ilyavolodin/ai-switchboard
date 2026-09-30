import {
  definePlugin,
  safeEqual,
  type PluginDefinition,
  type SourceType,
} from '@ai-switchboard/sdk';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildApiContext, type ApiContext } from '../../src/api/context.js';
import type { PipelinePort, PreviewPort } from '../../src/api/pipeline-port.js';
import { bootstrapAdmin } from '../../src/auth/bootstrap.js';
import { FakeClock } from '../../src/clock.js';
import { testConfig } from '../../src/config.js';
import { silentLogger } from '../../src/logger.js';
import { PluginHost } from '../../src/plugins/host.js';
import { MemoryQueue } from './memory-queue.js';
import { buildServer } from '../../src/server.js';
import { createRecordingTelemetry } from '../../src/telemetry/telemetry.js';
import type { TestDatabase } from './db.js';

export const TEST_VAULT: Record<string, string> = {
  SOURCE_SECRET: 's-fixture-vault-secret',
  UNUSED_TOKEN: 'fixture-vault-unused',
};

export const testSourceType: SourceType = {
  id: 'test-source',
  displayName: 'Test source',
  icon: 'webhook',
  mode: 'push',
  settingsSchema: {
    type: 'object',
    required: ['secret'],
    properties: {
      secret: { type: 'string', title: 'Secret', 'x-secret': true, pattern: '^s-' },
      org: { type: 'string', title: 'Org', default: 'acme' },
    },
  },
  eventTypes: [
    {
      type: 'test-source.item.created',
      title: 'Item created',
      description: 'An item was created',
      attributes: { type: 'object', properties: { label: { type: 'string' } } },
      examples: [{ label: 'x' }],
    },
  ],
  create: (settings) => ({
    verify: (req) =>
      safeEqual(req.headers['x-secret'], String(settings.secret))
        ? { ok: true }
        : { ok: false, reason: 'bad secret' },
    parse: () => [],
    health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date().toISOString() }),
  }),
};

const healthy = () =>
  Promise.resolve({ status: 'healthy' as const, checkedAt: new Date().toISOString() });

const itemCreated = (sourceId: string) => ({
  type: `${sourceId}.item.created`,
  title: 'Item created',
  description: 'An item was created',
  attributes: { type: 'object', properties: { label: { type: 'string' } } },
  examples: [{ label: 'x' }],
});

/** Like the generic webhook: may run without verify, when its settings say `none`. */
export const openSourceType: SourceType = {
  id: 'test-open',
  displayName: 'Test open',
  mode: 'push',
  allowsUnauthenticated: true,
  settingsSchema: {
    type: 'object',
    properties: {
      verification: { type: 'string', enum: ['secret', 'none'], default: 'secret' },
      secret: { type: 'string', 'x-secret': true },
    },
  },
  eventTypes: [itemCreated('test-open')],
  create: (settings) =>
    settings.verification === 'none'
      ? { parse: () => [], health: healthy }
      : {
          verify: (req) =>
            safeEqual(req.headers['x-secret'], String(settings.secret))
              ? { ok: true }
              : { ok: false, reason: 'bad secret' },
          parse: () => [],
          health: healthy,
        },
};

/** A push source that never verifies and whose type does not allow that. */
export const noVerifySourceType: SourceType = {
  id: 'test-noverify',
  displayName: 'Test no-verify',
  mode: 'push',
  settingsSchema: { type: 'object' },
  eventTypes: [itemCreated('test-noverify')],
  create: () => ({ parse: () => [], health: healthy }),
};

export const testPlugin: PluginDefinition = definePlugin({
  id: 'test-plugin',
  displayName: 'Test plugin',
  sources: [testSourceType, openSourceType, noVerifySourceType],
  destinations: [
    {
      id: 'test-destination',
      displayName: 'Test destination',
      settingsSchema: { type: 'object', properties: { url: { type: 'string' } } },
      targetSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
      inputSchema: { type: 'object' },
      examples: [{ target: { path: '/x' }, input: {} }],
      tracking: 'sync',
      idempotentInvoke: false,
      usage: [
        { id: 'tokens', title: 'Tokens', unit: 'tokens', aggregate: 'sum', budgetable: true },
      ],
      meters: [{ id: 'window', title: 'Window', kind: 'window', unit: '%', primary: true }],
      create: () => ({
        invoke: () => Promise.resolve({ status: 'completed' }),
        health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date().toISOString() }),
      }),
    },
  ],
  secretProviders: [
    {
      id: 'env',
      displayName: 'Env',
      settingsSchema: { type: 'object' },
      create: () => ({
        resolve: (name) => {
          const v = process.env[name];
          return v ? Promise.resolve(v) : Promise.reject(new Error(`${name} is not set`));
        },
        health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date().toISOString() }),
      }),
    },
    {
      // A provider that can list. Its listing deliberately carries an extra `value` field, so
      // tests can check the API strips anything but names, descriptions and times.
      id: 'test-vault',
      displayName: 'Test vault',
      settingsSchema: { type: 'object' },
      create: () => ({
        resolve: (name) => {
          const v = TEST_VAULT[name];
          return v ? Promise.resolve(v) : Promise.reject(new Error(`${name} is not in the vault`));
        },
        list: () =>
          Promise.resolve(
            Object.entries(TEST_VAULT).map(([name, value]) => ({
              name,
              description: `vault entry ${name}`,
              updatedAt: '2026-03-01T00:00:00.000Z',
              value,
            })),
          ),
        health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date().toISOString() }),
      }),
    },
  ],
});

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export function stubPipeline(calls: RecordedCall[]): PipelinePort {
  const rec =
    <T>(method: string, value: T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(value);
    };
  return {
    ingestPush: rec('ingestPush', 'accepted' as const),
    handleCallback: rec('handleCallback', 'accepted' as const),
    runNow: rec('runNow', { batchId: 'b', runId: 'r', outcome: 'invoked' }),
    approve: rec('approve', { runId: 'r', outcome: 'invoked' }),
    reject: rec('reject', undefined),
    replay: rec('replay', { eventIds: [] }),
    injectTestEvent: rec('injectTestEvent', { eventIds: [] }),
    closeRun: rec('closeRun', undefined),
    resetBreaker: rec('resetBreaker', undefined),
    clearSoftHold: rec('clearSoftHold', undefined),
    readMetersNow: rec('readMetersNow', undefined),
  };
}

export const stubPreview: PreviewPort = {
  filterPreview: () => Promise.resolve({ rows: [] }),
  inputPreview: () => Promise.resolve({ input: {}, valid: true, errors: [] }),
  cronPreview: (req) =>
    req.cron.split(' ').length === 5
      ? { valid: true, description: 'cron', next: [] }
      : { valid: false, description: '', next: [], error: 'invalid cron' },
  traceForArtifact: (query) => Promise.resolve({ query, artifacts: [], entries: [], text: '' }),
  traceForEvent: (query) => Promise.resolve({ query, artifacts: [], entries: [], text: '' }),
};

export interface ApiHarness {
  app: FastifyInstance;
  ctx: ApiContext;
  host: PluginHost;
  clock: FakeClock;
  calls: RecordedCall[];
  adminCookie: string;
  login(email: string, password: string): Promise<string>;
  request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    options?: { body?: unknown; cookie?: string; token?: string },
  ): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export const ADMIN_EMAIL = 'admin@switchboard.local';
export const ADMIN_PASSWORD = 'correct-horse-battery';

export interface ApiHarnessOptions {
  home?: string;
  runNpm?: ApiContext['runNpm'];
  registryFetch?: ApiContext['registryFetch'];
  plugins?: { name: string; version: string; definition: PluginDefinition }[];
}

export async function createApiHarness(
  tdb: TestDatabase,
  options: ApiHarnessOptions = {},
): Promise<ApiHarness> {
  const clock = new FakeClock('2026-03-02T10:00:00Z');
  const logger = silentLogger();
  const telemetry = createRecordingTelemetry();
  const config = testConfig({
    databaseUrl: tdb.url,
    home: options.home ?? `/tmp/sb-test-${Date.now()}`,
  });
  const host = new PluginHost({
    db: tdb.db,
    clock,
    logger,
    telemetry,
    config,
    builtin: [
      { name: 'test-plugin', version: '1.0.0', definition: testPlugin },
      ...(options.plugins ?? []),
    ],
    scanDirs: [],
    ...(options.runNpm ? { runNpm: options.runNpm } : {}),
  });
  await host.boot();
  const calls: RecordedCall[] = [];
  const ctx = buildApiContext({
    deps: {
      db: tdb.db,
      clock,
      runtime: host,
      queue: new MemoryQueue(clock),
      logger,
      telemetry,
      config,
    },
    host,
    pipeline: stubPipeline(calls),
    preview: stubPreview,
    oidc: undefined,
    runNpm: options.runNpm,
    registryFetch: options.registryFetch,
  });
  await bootstrapAdmin(tdb.db, config, logger, clock.now(), { password: ADMIN_PASSWORD });
  const app = await buildServer(ctx, { serveUi: false });
  await app.ready();

  const request: ApiHarness['request'] = (method, url, options = {}) =>
    app.inject({
      method,
      url,
      ...(options.body !== undefined ? { payload: options.body as object } : {}),
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    });
  const login = async (email: string, password: string): Promise<string> => {
    const res = await request('POST', '/api/v1/auth/login', { body: { email, password } });
    const set = res.headers['set-cookie'];
    const cookie = (Array.isArray(set) ? set[0] : set)?.split(';')[0];
    if (res.statusCode !== 200 || !cookie)
      throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    return cookie;
  };
  const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  return { app, ctx, host, clock, calls, adminCookie, login, request, close: () => app.close() };
}
