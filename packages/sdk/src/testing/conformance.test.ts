import { describe, expect, it } from 'vitest';

import {
  dedupeKey,
  definePlugin,
  SecretNotFoundError,
  signHmac,
  verifyHmacHeader,
  type Attributes,
  type Destination,
  type DestinationType,
  type EventDraft,
  type HealthStatus,
  type JSONSchema,
  type Notifier,
  type NotifierType,
  type PluginDefinition,
  type RawRequest,
  type SecretListing,
  type SecretProvider,
  type SecretProviderType,
  type Source,
  type SourceType,
} from '../index.js';
import {
  ConformanceFailure,
  destinationConformanceChecks,
  notifierConformanceChecks,
  pluginConformanceChecks,
  rawRequest,
  runConformance,
  secretProviderConformanceChecks,
  settingsSchemaChecks,
  sourceConformanceChecks,
  type ConformanceCheck,
  type DestinationFixtures,
  type PluginFixtures,
  type SettingsSchemaOptions,
  type SourceFixtures,
} from './index.js';

const VALUES: Record<string, string> = {
  GITHUB_TOKEN: 'fixture-secret-github',
  PIN: 'abc',
};

function providerType(list?: () => Promise<unknown[]>): SecretProviderType {
  return {
    id: 'demo',
    displayName: 'Demo',
    settingsSchema: { type: 'object', properties: {} },
    create: (): SecretProvider => ({
      resolve: (name) => {
        const value = VALUES[name];
        return value === undefined
          ? Promise.reject(new Error(`${name} is not set`))
          : Promise.resolve(value);
      },
      health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date(0).toISOString() }),
      ...(list ? { list: list as () => Promise<SecretListing[]> } : {}),
    }),
  };
}

async function failures(checks: ConformanceCheck[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const check of checks) {
    try {
      await check.run();
    } catch (err) {
      expect(err).toBeInstanceOf(ConformanceFailure);
      out[check.name] = (err as Error).message;
    }
  }
  return out;
}

const good = providerType(() =>
  Promise.resolve([
    { name: 'GITHUB_TOKEN', updatedAt: '2026-01-01T00:00:00.000Z' },
    { name: 'PIN', description: 'door code' },
  ]),
);

runConformance(
  'a provider that lists names only',
  secretProviderConformanceChecks(good, { settings: {}, expectNames: ['GITHUB_TOKEN'] }),
  { describe, it },
);

runConformance(
  'a provider without list()',
  secretProviderConformanceChecks(providerType(), { settings: {} }),
  { describe, it },
);

describe('secretProviderConformanceChecks', () => {
  it('fails a provider whose listing carries a value in an extra field', async () => {
    const leaky = providerType(() =>
      Promise.resolve([{ name: 'GITHUB_TOKEN', value: 'fixture-secret-github' }]),
    );
    const failed = await failures(secretProviderConformanceChecks(leaky, { settings: {} }));
    expect(failed['list() returns well-formed names']).toMatch(/unexpected field "value"/);
    expect(failed['list() never contains a secret value']).toMatch(/contains a secret value/);
  });

  it('fails a provider that leaks part of a value in the description', async () => {
    const leaky = providerType(() =>
      Promise.resolve([{ name: 'GITHUB_TOKEN', description: 'starts fixture-secret-github…' }]),
    );
    const failed = await failures(secretProviderConformanceChecks(leaky, { settings: {} }));
    expect(failed['list() never contains a secret value']).toMatch(/contains a secret value/);
  });

  it('matches a short value only as an exact field', async () => {
    const shortLeak = providerType(() => Promise.resolve([{ name: 'PIN', description: 'abc' }]));
    const failed = await failures(secretProviderConformanceChecks(shortLeak, { settings: {} }));
    expect(failed['list() never contains a secret value']).toBeDefined();
    // "abc" inside a longer word is not a leak worth failing on.
    const fine = providerType(() => Promise.resolve([{ name: 'PIN', description: 'fabcd' }]));
    expect(await failures(secretProviderConformanceChecks(fine, { settings: {} }))).toEqual({});
  });

  it('checks the extra secrets fixture even for names that do not resolve', async () => {
    const leaky = providerType(() =>
      Promise.resolve([{ name: 'UNSET', description: 'fixture-secret-extra' }]),
    );
    const failed = await failures(
      secretProviderConformanceChecks(leaky, { settings: {}, secrets: ['fixture-secret-extra'] }),
    );
    expect(failed['list() never contains a secret value']).toBeDefined();
  });

  it('fails on missing, duplicate or malformed entries', async () => {
    const bad = providerType(() =>
      Promise.resolve([{ name: 'PIN' }, { name: 'PIN' }, { name: 'X', updatedAt: 'yesterday' }]),
    );
    const failed = await failures(
      secretProviderConformanceChecks(bad, { settings: {}, expectNames: ['GITHUB_TOKEN'] }),
    );
    expect(failed['list() returns well-formed names']).toMatch(/twice/);
    const noName = providerType(() => Promise.resolve([{ description: 'x' }]));
    expect(
      (await failures(secretProviderConformanceChecks(noName, { settings: {} })))[
        'list() returns well-formed names'
      ],
    ).toMatch(/no name/);
    const missing = providerType(() => Promise.resolve([{ name: 'PIN' }]));
    expect(
      (
        await failures(
          secretProviderConformanceChecks(missing, { settings: {}, expectNames: ['GITHUB_TOKEN'] }),
        )
      )['list() returns well-formed names'],
    ).toMatch(/expected name "GITHUB_TOKEN"/);
    const badTime = providerType(() => Promise.resolve([{ name: 'X', updatedAt: 'yesterday' }]));
    expect(
      (await failures(secretProviderConformanceChecks(badTime, { settings: {} })))[
        'list() returns well-formed names'
      ],
    ).toMatch(/ISO-8601/);
  });
});

describe('sourceConformanceChecks: parseWithNotes', () => {
  const event: EventDraft = {
    type: 'demo.thing.happened',
    occurredAt: '2026-01-01T00:00:00.000Z',
    artifact: { kind: 'thing', id: '1' },
    attributes: {},
    dedupeKey: 'demo.thing.happened:thing:1:',
  };
  const sourceType = (notesEvents: EventDraft[]): SourceType => ({
    id: 'demo',
    displayName: 'Demo',
    mode: 'push',
    settingsSchema: { type: 'object', properties: {} },
    allowsUnauthenticated: true,
    eventTypes: [
      {
        type: 'demo.thing.happened',
        title: 'Thing',
        description: 'Thing',
        attributes: { type: 'object', properties: {} },
        examples: [{}],
      },
    ],
    create: () => ({
      parse: () => [event],
      parseWithNotes: () => ({ events: notesEvents, notes: ['a note'] }),
      health: () => Promise.resolve({ status: 'unknown', checkedAt: event.occurredAt }),
    }),
  });
  const delivery = rawRequest({ body: '{}' });
  const fixtures = {
    settings: {},
    push: {
      deliveries: [delivery],
      sameChange: [delivery, delivery] as [typeof delivery, typeof delivery],
      differentChange: [delivery, delivery] as [typeof delivery, typeof delivery],
      wrongSignature: delivery,
      missingHeader: delivery,
    },
  };
  const name = 'parseWithNotes (when present) returns the same events as parse';

  it('passes when parseWithNotes agrees with parse', async () => {
    expect((await failures(sourceConformanceChecks(sourceType([event]), fixtures)))[name]).toBe(
      undefined,
    );
  });

  it('fails when parseWithNotes returns different events', async () => {
    expect((await failures(sourceConformanceChecks(sourceType([]), fixtures)))[name]).toMatch(
      /different events/,
    );
  });
});

const SECRET = 'fixture-secret';
const NOW = new Date('2026-09-29T12:00:00Z');

const settingsSchema: JSONSchema = {
  type: 'object',
  properties: {
    webhookSecret: {
      type: 'string',
      title: 'Webhook secret',
      description: 'Signs deliveries.',
      'x-secret': true,
    },
  },
};

interface SourceParts {
  id?: string;
  mode?: SourceType['mode'];
  examples?: Attributes[];
  source?: Partial<Source>;
}

function demoSource(parts: SourceParts = {}): SourceType {
  const type = 'demo.item.created';
  return {
    id: parts.id ?? 'demo',
    displayName: 'Demo',
    mode: parts.mode ?? 'push',
    settingsSchema,
    eventTypes: [
      {
        type,
        title: 'Item created',
        description: 'An item was created.',
        attributes: { type: 'object', properties: { title: { type: 'string' } } },
        examples: parts.examples ?? [{ title: 'first' }],
      },
    ],
    create: (_settings, ctx): Source => ({
      verify: (req) => verifyHmacHeader(req, { header: 'x-sig', secret: SECRET }),
      parse: (req) => {
        const body = JSON.parse(req.body.toString('utf8')) as {
          id: string;
          v: string;
          title: string;
        };
        const artifact = { kind: 'demo.item', id: body.id, version: body.v };
        return [
          {
            type,
            occurredAt: req.receivedAt,
            artifact,
            attributes: { title: body.title },
            dedupeKey: dedupeKey(type, artifact),
          },
        ];
      },
      resolve: async (ref) => {
        const res = await ctx.http.get(`https://api.demo.test/items/${ref.id}`);
        return res.status === 404 ? null : { ref, title: 'x' };
      },
      health: () => Promise.resolve({ status: 'healthy', checkedAt: ctx.now().toISOString() }),
      ...parts.source,
    }),
  };
}

function signed(body: object): RawRequest {
  const text = JSON.stringify(body);
  return rawRequest({
    headers: { 'x-sig': signHmac({ secret: SECRET, payload: text }) },
    body: text,
  });
}

const pushFixtures: SourceFixtures = {
  settings: { webhookSecret: SECRET },
  now: () => NOW,
  push: {
    deliveries: [signed({ id: '1', v: 'a', title: 'first' })],
    sameChange: [
      signed({ id: '1', v: 'a', title: 'first' }),
      signed({ id: '1', v: 'a', title: 'first' }),
    ],
    differentChange: [
      signed({ id: '1', v: 'a', title: 'first' }),
      signed({ id: '1', v: 'b', title: 'renamed' }),
    ],
    wrongSignature: rawRequest({ headers: { 'x-sig': 'deadbeef' }, body: '{}' }),
    missingHeader: rawRequest({ body: '{}' }),
  },
  resolveNotFound: { kind: 'demo.item', id: 'gone' },
};

runConformance('a well-behaved source', sourceConformanceChecks(demoSource(), pushFixtures), {
  describe,
  it,
});

describe('sourceConformanceChecks fail a bad source', () => {
  let counter = 0;
  it.each<[string, SourceType, SourceFixtures, RegExp]>([
    ['manifest validates', demoSource({ id: 'Bad_Id' }), pushFixtures, /kebab-case/],
    [
      'every declared event type has a schema and at least one example',
      demoSource({ examples: [] }),
      pushFixtures,
      /no examples/,
    ],
    [
      'health() resolves to a Health',
      demoSource({
        source: {
          health: () => Promise.resolve({ status: 'fine' as HealthStatus, checkedAt: '' }),
        },
      }),
      pushFixtures,
      /health status is invalid/,
    ],
    [
      'push fixtures are provided',
      demoSource(),
      { settings: pushFixtures.settings },
      /must provide push fixtures/,
    ],
    [
      'verify accepts correctly signed deliveries',
      demoSource({ source: { verify: () => ({ ok: false, reason: 'no' }) } }),
      pushFixtures,
      /rejected a valid delivery/,
    ],
    [
      'verify rejects a wrong signature, a missing header and a stale timestamp',
      demoSource({ source: { verify: () => ({ ok: true }) } }),
      pushFixtures,
      /accepted a wrong signature/,
    ],
    [
      'parse is deterministic and its events validate against the declared schemas',
      demoSource({
        source: {
          parse: () => {
            counter += 1;
            return [
              {
                type: 'demo.item.created',
                occurredAt: NOW.toISOString(),
                artifact: { kind: 'demo.item', id: '1' },
                attributes: { title: `n${String(counter)}` },
                dedupeKey: 'k',
              },
            ];
          },
        },
      }),
      pushFixtures,
      /different events/,
    ],
    [
      'dedupeKey is stable for the same change and differs across changes',
      demoSource({
        source: {
          parse: () => [
            {
              type: 'demo.item.created',
              occurredAt: NOW.toISOString(),
              artifact: { kind: 'demo.item', id: '1' },
              attributes: {},
              dedupeKey: 'always-the-same',
            },
          ],
        },
      }),
      pushFixtures,
      /share a dedupe key/,
    ],
    [
      'resolve handles a 404',
      demoSource({ source: { resolve: (ref) => Promise.resolve({ ref }) } }),
      pushFixtures,
      /must return null/,
    ],
    [
      'poll advances the watermark and never re-emits',
      demoSource({
        mode: 'pull',
        source: {
          poll: () =>
            Promise.resolve({
              watermark: 'w',
              events: [
                {
                  type: 'demo.item.created',
                  occurredAt: NOW.toISOString(),
                  artifact: { kind: 'demo.item', id: '1' },
                  attributes: {},
                  dedupeKey: 'same',
                },
              ],
            }),
        },
      }),
      { settings: pushFixtures.settings, poll: { initialWatermark: null } },
      /re-emitted/,
    ],
  ])('%s', async (name, type, fixtures, message) => {
    expect((await failures(sourceConformanceChecks(type, fixtures)))[name]).toMatch(message);
  });
});

interface DestinationParts {
  type?: Partial<DestinationType>;
  destination?: Partial<Destination>;
}

function demoDestination(parts: DestinationParts = {}): DestinationType {
  return {
    id: 'demo-run',
    displayName: 'Demo run',
    settingsSchema,
    targetSchema: { type: 'object', properties: { job: { type: 'string' } } },
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    examples: [{ target: { job: 'build' }, input: { text: 'hi' } }],
    tracking: 'callback',
    idempotentInvoke: false,
    usage: [{ id: 'tokens', title: 'Tokens', unit: 'tokens', aggregate: 'sum', budgetable: true }],
    meters: [{ id: 'quota', title: 'Quota', kind: 'allowance', unit: 'runs' }],
    create: (_settings, ctx): Destination => ({
      invoke: async () => {
        const res = await ctx.http.post('https://api.demo.test/run');
        return res.ok ? { status: 'started', usage: { tokens: 3 } } : { status: 'failed' };
      },
      verifyCallback: () => null,
      readMeters: () =>
        Promise.resolve([{ id: 'quota', utilization: 40, observedAt: ctx.now().toISOString() }]),
      health: () => Promise.resolve({ status: 'unknown', checkedAt: ctx.now().toISOString() }),
      ...parts.destination,
    }),
    ...parts.type,
  };
}

const destinationFixtures: DestinationFixtures = {
  settings: { webhookSecret: SECRET },
  http: () => ({ status: 200, json: {} }),
  unsignedCallback: rawRequest({ body: '{}' }),
  now: () => NOW,
};

runConformance(
  'a well-behaved destination',
  destinationConformanceChecks(demoDestination(), destinationFixtures),
  { describe, it },
);

describe('destinationConformanceChecks fail a bad destination', () => {
  it.each<[string, DestinationParts, RegExp]>([
    ['manifest validates', { type: { id: 'Bad_Id' } }, /kebab-case/],
    [
      'targetSchema and inputSchema are valid schemas with examples',
      { type: { examples: [] } },
      /example is required/,
    ],
    [
      'idempotentInvoke is declared',
      { type: { idempotentInvoke: undefined as unknown as boolean } },
      /must be a boolean/,
    ],
    [
      'the declared tracking mode has its method',
      { type: { tracking: 'poll' } },
      /requires poll\(\)/,
    ],
    [
      'invoke with the example target and input returns a well-formed InvokeResult',
      { destination: { invoke: () => Promise.resolve({ status: 'completed' }) } },
      /only sync destinations/,
    ],
    [
      'verifyCallback rejects an unsigned request',
      {
        destination: {
          verifyCallback: () => ({ runId: 'r', status: { state: 'ok' } }),
        },
      },
      /accepted an unsigned request/,
    ],
    [
      'readMeters returns readings matching the declared meters',
      {
        destination: {
          readMeters: () =>
            Promise.resolve([{ id: 'other', utilization: 10, observedAt: NOW.toISOString() }]),
        },
      },
      /undeclared meter "other"/,
    ],
    [
      'every usage dimension has a unit',
      {
        type: {
          usage: [{ id: 'tokens', title: 'Tokens', unit: '', aggregate: 'sum', budgetable: true }],
        },
      },
      /has no unit/,
    ],
  ])('%s', async (name, parts, message) => {
    const checks = destinationConformanceChecks(demoDestination(parts), destinationFixtures);
    expect((await failures(checks))[name]).toMatch(message);
  });
});

function demoNotifier(parts: { id?: string; notifier?: Partial<Notifier> } = {}): NotifierType {
  return {
    id: parts.id ?? 'demo-notify',
    displayName: 'Demo notify',
    settingsSchema,
    create: (_settings, ctx): Notifier => ({
      send: async (message) => {
        const res = await ctx.http.post('https://hooks.demo.test/notify', { json: message });
        if (!res.ok) throw new Error(`answered ${String(res.status)}`);
      },
      health: () => Promise.resolve({ status: 'unknown', checkedAt: ctx.now().toISOString() }),
      ...parts.notifier,
    }),
  };
}

runConformance(
  'a well-behaved notifier',
  notifierConformanceChecks(demoNotifier(), { settings: {} }),
  { describe, it },
);

describe('notifierConformanceChecks fail a bad notifier', () => {
  it.each<[string, NotifierType, RegExp]>([
    ['manifest validates', demoNotifier({ id: 'Bad_Id' }), /kebab-case/],
    [
      'health() resolves to a Health',
      demoNotifier({
        notifier: {
          health: () => Promise.resolve({ status: 'up' as HealthStatus, checkedAt: '' }),
        },
      }),
      /health status is invalid/,
    ],
    [
      'send delivers a message with one or more requests',
      demoNotifier({ notifier: { send: () => Promise.resolve() } }),
      /made no request/,
    ],
    [
      'send rejects when the backend refuses',
      demoNotifier({
        notifier: {
          send: async () => {
            await Promise.resolve();
          },
        },
      }),
      /resolved although the backend answered 500/,
    ],
  ])('%s', async (name, type, message) => {
    expect((await failures(notifierConformanceChecks(type, { settings: {} })))[name]).toMatch(
      message,
    );
  });
});

describe('settingsSchemaChecks', () => {
  const titled = { title: 'T', description: 'D' };
  it('passes a schema that follows the form rules', async () => {
    expect(await failures(settingsSchemaChecks(settingsSchema))).toEqual({});
  });

  it.each<[string, JSONSchema, SettingsSchemaOptions, RegExp]>([
    [
      'every settings field has a title and a description',
      {
        type: 'object',
        properties: {
          url: { type: 'string', title: 'URL' },
          auth: { type: 'object', ...titled, properties: { user: { type: 'string' } } },
        },
      },
      {},
      /url \(description\); auth\.user \(title, description\)/,
    ],
    [
      'credential settings fields are marked x-secret',
      {
        type: 'object',
        properties: {
          apiToken: { type: 'string', ...titled },
          tokenHeader: { type: 'string', ...titled },
          auth: {
            type: 'object',
            ...titled,
            properties: { privateKey: { type: 'string', ...titled } },
          },
        },
      },
      {},
      /without x-secret: apiToken, auth\.privateKey$/,
    ],
  ])('fails: %s', async (name, schema, options, message) => {
    expect((await failures(settingsSchemaChecks(schema, options)))[name]).toMatch(message);
  });

  it('skips fields listed in notSecret', async () => {
    const schema = { type: 'object', properties: { csrfToken: { type: 'string', ...titled } } };
    expect(await failures(settingsSchemaChecks(schema, { notSecret: ['csrfToken'] }))).toEqual({});
  });
});

describe('pluginConformanceChecks with fixtures', () => {
  const plugin = (destination: DestinationType): PluginDefinition =>
    definePlugin({
      id: 'demo',
      displayName: 'Demo',
      sources: [demoSource()],
      destinations: [destination],
      notifiers: [demoNotifier()],
      capabilities: { network: ['api.demo.test', 'hooks.demo.test'] },
    });
  const fixtures: PluginFixtures = {
    sources: { demo: pushFixtures },
    destinations: { 'demo-run': destinationFixtures },
    notifiers: { 'demo-notify': { settings: {} } },
  };

  it('keeps the manifest-only form without fixtures', () => {
    expect(pluginConformanceChecks(plugin(demoDestination())).map((c) => c.name)).toEqual([
      'plugin demo manifest validates',
    ]);
  });

  it('passes a plugin whose calls stay inside capabilities.network', async () => {
    const checks = pluginConformanceChecks(plugin(demoDestination()), fixtures);
    expect(checks.map((c) => c.name)).toContain('source demo: resolve handles a 404');
    expect(checks.map((c) => c.name)).toContain(
      'notifier demo-notify: every settings field has a title and a description',
    );
    expect(await failures(checks)).toEqual({});
  });

  it('fails a plugin that calls an undeclared host, even when the error is swallowed', async () => {
    const base = demoDestination();
    const sneaky: DestinationType = {
      ...base,
      create: (settings, ctx) => ({
        ...base.create(settings, ctx),
        readMeters: () =>
          ctx.http.get('https://evil.test/collect').then(
            () => [],
            () => [],
          ),
      }),
    };
    const failed = await failures(pluginConformanceChecks(plugin(sneaky), fixtures));
    expect(failed['plugin demo calls only the hosts in capabilities.network']).toMatch(
      /evil\.test/,
    );
  });
});

interface WritableFlaws {
  leakInError?: boolean;
  leakInLog?: boolean;
  noDelete?: boolean;
  forgets?: boolean;
}

function writableType(flaws: WritableFlaws = {}): SecretProviderType {
  return {
    id: 'store',
    displayName: 'Store',
    settingsSchema: { type: 'object', properties: {} },
    create: (_settings, ctx): SecretProvider => {
      const data = new Map<string, string>();
      const provider: SecretProvider = {
        resolve: (name) => {
          const value = data.get(name);
          return value === undefined
            ? Promise.reject(new SecretNotFoundError(`${name} is not stored`))
            : Promise.resolve(value);
        },
        health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date(0).toISOString() }),
        set: (name, value) => {
          if (!/^[a-z0-9-]+$/.test(name))
            return Promise.reject(
              new Error(
                flaws.leakInError ? `cannot store ${value} under ${name}` : `bad name ${name}`,
              ),
            );
          if (flaws.leakInLog) ctx.logger.debug('stored', { name, value });
          if (!flaws.forgets) data.set(name, value);
          return Promise.resolve();
        },
      };
      if (!flaws.noDelete)
        provider.delete = (name) => {
          data.delete(name);
          return Promise.resolve();
        };
      return provider;
    },
  };
}

runConformance(
  'a writable provider',
  secretProviderConformanceChecks(writableType(), { settings: {} }),
  { describe, it },
);

describe('secretProviderConformanceChecks for writable providers', () => {
  const ROUND_TRIP = 'set() and delete() round-trip through resolve()';
  const NO_LEAK = 'writes never put the value in an error or a log line';

  it('fails a provider with set() but no delete()', async () => {
    const failed = await failures(
      secretProviderConformanceChecks(writableType({ noDelete: true }), { settings: {} }),
    );
    expect(failed['set() and delete() come together']).toMatch(/both/);
  });

  it('fails a provider that does not keep what it was given', async () => {
    const failed = await failures(
      secretProviderConformanceChecks(writableType({ forgets: true }), { settings: {} }),
    );
    expect(failed[ROUND_TRIP]).toMatch(/resolve\(\) after set\(\)/);
  });

  it('fails a provider that echoes the value in an error', async () => {
    const failed = await failures(
      secretProviderConformanceChecks(writableType({ leakInError: true }), { settings: {} }),
    );
    expect(failed[NO_LEAK]).toMatch(/error/);
  });

  it('fails a provider that logs the value', async () => {
    const failed = await failures(
      secretProviderConformanceChecks(writableType({ leakInLog: true }), { settings: {} }),
    );
    expect(failed[NO_LEAK]).toMatch(/log/);
  });

  it('skips the write checks for a read-only provider', async () => {
    expect(
      await failures(secretProviderConformanceChecks(providerType(), { settings: {} })),
    ).toEqual({});
  });
});
