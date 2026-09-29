import { describe, expect, it } from 'vitest';

import { validatePlugin, type EventDraft, type Settings } from '@ai-switchboard/sdk';
import {
  createStubHttp,
  createTestContext,
  runConformance,
  sourceConformanceChecks,
  type StubHandler,
} from '@ai-switchboard/sdk/testing';

import incidentsFixture from './__fixtures__/incidents.json' with { type: 'json' };
import baseSettings from './__fixtures__/settings.json' with { type: 'json' };
import plugin from './plugin.js';
import { pollHttpSource } from './source.js';
import { decodeWatermark, encodeWatermark, selectNew } from './watermark.js';

const TOKEN = 'fixture-token';
const NOW = new Date('2026-09-27T10:05:00.000Z');
const ENDPOINT = 'https://status.example.com/api/v2/incidents';

type Incident = (typeof incidentsFixture.data.incidents)[number];

function settings(overrides: Settings = {}): Settings {
  return { ...structuredClone(baseSettings), ...overrides };
}

function page(incidents: Incident[]) {
  return { ...incidentsFixture, data: { incidents } };
}

/** A well-behaved endpoint: returns incidents updated at or after `updated_since` (inclusive). */
function inclusiveApi(incidents: Incident[] = incidentsFixture.data.incidents): StubHandler {
  return (req) => {
    if (req.url.origin + req.url.pathname !== ENDPOINT) return undefined;
    const since = req.url.searchParams.get('updated_since');
    return {
      json: page(incidents.filter((i) => since === null || i.updated_at >= since)),
    };
  };
}

function make(s: Settings = settings(), handler: StubHandler = inclusiveApi()) {
  const stub = createStubHttp(handler);
  const source = pollHttpSource.create(s, createTestContext({ http: stub.client, now: () => NOW }));
  return { source, calls: stub.calls };
}

async function pollAll(s: Settings, handler: StubHandler, rounds: number) {
  const { source, calls } = make(s, handler);
  let watermark: string | null = null;
  const perRound: EventDraft[][] = [];
  for (let i = 0; i < rounds; i++) {
    const result = await source.poll!(watermark);
    perRound.push(result.events);
    watermark = result.watermark;
  }
  return { perRound, calls, watermark };
}

runConformance(
  'poll-http source',
  sourceConformanceChecks(pollHttpSource, {
    settings: settings(),
    secrets: [TOKEN],
    http: inclusiveApi(),
    now: () => NOW,
    poll: { initialWatermark: null },
  }),
  { describe, it },
);

runConformance(
  'poll-http source (endpoint ignores the cursor)',
  sourceConformanceChecks(pollHttpSource, {
    settings: settings({ healthUrl: 'https://status.example.com/api/v2/status' }),
    secrets: [TOKEN],
    http: (req) =>
      req.url.pathname.endsWith('/status') ? { json: { ok: true } } : { json: incidentsFixture },
    now: () => NOW,
    poll: { initialWatermark: null },
  }),
  { describe, it },
);

describe('poll-http manifest', () => {
  it('validates, is pull-only and declares its network reach', () => {
    expect(validatePlugin(plugin)).toEqual([]);
    expect(pollHttpSource.mode).toBe('pull');
    expect(pollHttpSource.dynamicEventTypes).toBe(true);
    expect(plugin.capabilities.network).toEqual(['*']);
  });

  it('builds instance event types from the settings', () => {
    const specs = pollHttpSource.instanceEventTypes!(settings());
    expect(specs.map((s) => s.type)).toEqual([
      'poll-http.incident.updated',
      'poll-http.incident.resolved',
    ]);
    expect(specs[0]!.examples[0]).toEqual({
      title: 'Elevated API error rate',
      impact: 'major',
      status: 'investigating',
      components: ['API'],
    });
  });

  it('rejects event types outside the poll-http namespace and bad expressions', () => {
    const s = settings();
    (s.eventTypes as { type: string }[])[0]!.type = 'webhook.incident.updated';
    expect(() => make(s)).toThrow(/Invalid poll-http settings/);
    expect(() => make(settings({ itemsExpression: 'data.[' }))).toThrow(/items expression/);
    expect(() => make(settings({ url: 'ftp://status.example.com' }))).toThrow(/Invalid/);
  });
});

describe('poll-http poll', () => {
  it('maps items to events in occurredAt order with declared attributes only', async () => {
    const { source, calls } = make();
    const { events } = await source.poll!(null);
    expect(events.map((e) => [e.type, e.artifact.id, e.occurredAt])).toEqual([
      ['poll-http.incident.resolved', 'inc_01J8Y7', '2026-09-27T09:31:05.000Z'],
      ['poll-http.incident.updated', 'inc_01J8Z3', '2026-09-27T10:02:40.000Z'],
      ['poll-http.incident.updated', 'inc_01J8X1', '2026-09-27T10:02:40.000Z'],
    ]);
    expect(events[0]).toEqual({
      type: 'poll-http.incident.resolved',
      occurredAt: '2026-09-27T09:31:05.000Z',
      artifact: {
        kind: 'incident',
        id: 'inc_01J8Y7',
        url: 'https://status.example.com/incidents/inc_01J8Y7',
        version: '2026-09-27T09:31:05Z',
      },
      attributes: {
        title: 'Delayed webhook deliveries',
        impact: 'minor',
        status: 'resolved',
        components: ['Webhooks', 'API'],
      },
      dedupeKey: 'poll-http.incident.resolved:incident:inc_01J8Y7:2026-09-27T09:31:05Z',
    });
    expect(events[1]!.attributes.components).toEqual(['API']);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.url.searchParams.has('updated_since')).toBe(false);
  });

  it('sends the latest occurredAt as the cursor on the next poll', async () => {
    const { calls } = await pollAll(settings(), inclusiveApi(), 2);
    expect(calls[1]!.url.searchParams.get('updated_since')).toBe('2026-09-27T10:02:40.000Z');
  });

  it('never re-emits, even when the endpoint ignores the cursor', async () => {
    const everything: StubHandler = () => ({ json: incidentsFixture });
    const { perRound } = await pollAll(settings(), everything, 3);
    expect(perRound.map((r) => r.length)).toEqual([3, 0, 0]);
  });

  it('emits a new item that shares the boundary timestamp, and a later version of a seen one', async () => {
    let incidents = [...incidentsFixture.data.incidents];
    const handler: StubHandler = (req) => inclusiveApi(incidents)(req);
    const { source } = make(settings(), handler);
    const first = await source.poll!(null);
    incidents = [
      ...incidents,
      { ...incidents[2]!, id: 'inc_01J8W0', name: 'Late arrival' },
      { ...incidents[0]!, status: 'identified', updated_at: '2026-09-27T10:04:00Z' },
    ];
    const second = await source.poll!(first.watermark);
    expect(second.events.map((e) => [e.artifact.id, e.attributes.status])).toEqual([
      ['inc_01J8W0', 'monitoring'],
      ['inc_01J8Z3', 'identified'],
    ]);
    const third = await source.poll!(second.watermark);
    expect(third.events).toEqual([]);
  });

  it('keeps the watermark when nothing new arrived', async () => {
    const { source } = make(settings(), () => ({ json: page([]) }));
    const first = await source.poll!(null);
    expect(first.events).toEqual([]);
    expect(decodeWatermark(first.watermark, undefined)).toEqual({
      cursor: null,
      at: null,
      seen: [],
    });
  });

  it('starts from an initial watermark and skips items at or before it', async () => {
    const { source, calls } = make(settings({ initialWatermark: '2026-09-27T10:00:00Z' }));
    const { events } = await source.poll!(null);
    expect(calls[0]!.url.searchParams.get('updated_since')).toBe('2026-09-27T10:00:00Z');
    expect(events.map((e) => e.artifact.id)).toEqual(['inc_01J8Z3', 'inc_01J8X1']);
  });

  it('accepts a plain (hand-set) watermark string as the cursor', async () => {
    const { source, calls } = make(settings(), () => ({ json: incidentsFixture }));
    const { events } = await source.poll!('2026-09-27T09:40:00Z');
    expect(calls[0]!.url.searchParams.get('updated_since')).toBe('2026-09-27T09:40:00Z');
    expect(events).toHaveLength(2);
  });

  it('uses a cursor expression for opaque cursors', async () => {
    const s = settings({
      cursorParam: 'cursor',
      cursorExpression: 'response.body.meta.next_cursor',
    });
    const { calls, perRound } = await pollAll(s, () => ({ json: incidentsFixture }), 2);
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('c_20260927T100240');
    expect(perRound[1]).toEqual([]);
  });

  it('keeps the previous cursor when the cursor expression yields nothing', async () => {
    const s = settings({ cursorParam: 'cursor', cursorExpression: 'response.body.meta.missing' });
    const { calls } = await pollAll(
      { ...s, initialWatermark: 'c_0' },
      () => ({ json: incidentsFixture }),
      2,
    );
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('c_0');
  });

  it('POSTs the cursor in the JSON body when configured', async () => {
    const s = settings({
      method: 'POST',
      cursorIn: 'body',
      body: { query: 'status != "postmortem"' },
    });
    const { calls } = await pollAll(s, () => ({ json: incidentsFixture }), 2);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.json()).toEqual({ query: 'status != "postmortem"' });
    expect(calls[1]!.json()).toEqual({
      query: 'status != "postmortem"',
      updated_since: '2026-09-27T10:02:40.000Z',
    });
    expect(calls[1]!.url.search).toBe('');
  });

  it('sends the bare token in a custom token header', async () => {
    const { source, calls } = make(
      settings({ tokenHeader: 'X-Api-Key', headers: { 'x-tenant': 'acme' } }),
    );
    await source.poll!(null);
    const headers = calls[0]!.headers;
    expect(headers['x-api-key']).toBe(TOKEN);
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-tenant']).toBe('acme');
  });

  it('defaults occurredAt to the poll time and tells versions apart by it', async () => {
    const s = settings({
      mapping:
        "{ 'type': 'poll-http.incident.updated', 'artifact': { 'kind': 'incident', 'id': item.id }, 'attributes': { 'title': item.name } }",
    });
    const { source } = make(s);
    const { events } = await source.poll!(null);
    expect(events[0]!.occurredAt).toBe(NOW.toISOString());
    expect(events[0]!.dedupeKey).toBe(
      `poll-http.incident.updated:incident:inc_01J8Z3:${NOW.toISOString()}`,
    );
  });

  it('throws a PollError for a refusal or a non-JSON answer', async () => {
    const refused = make(settings(), () => ({ status: 503, body: 'down' }));
    await expect(refused.source.poll!(null)).rejects.toMatchObject({
      name: 'PollError',
      message: 'status.example.com answered 503',
    });
    const html = make(settings(), () => ({ body: '<html>login</html>' }));
    await expect(html.source.poll!(null)).rejects.toThrow(/did not answer with JSON/);
  });

  it('treats a non-array items result as one item', async () => {
    const s = settings({ itemsExpression: 'data.incidents[0]' });
    const { source } = make(s);
    expect((await source.poll!(null)).events).toHaveLength(1);
  });
});

describe('poll-http health', () => {
  it('is unknown without a health URL', async () => {
    const { source, calls } = make();
    expect((await source.health()).status).toBe('unknown');
    expect(calls).toHaveLength(0);
  });

  it('checks the health URL with the same credentials', async () => {
    const s = settings({ healthUrl: 'https://status.example.com/api/v2/status' });
    const ok = make(s, () => ({ json: {} }));
    expect(await ok.source.health()).toEqual({ status: 'healthy', checkedAt: NOW.toISOString() });
    expect(ok.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const down = make(s, () => ({ status: 401 }));
    expect(await down.source.health()).toMatchObject({
      status: 'unhealthy',
      message: 'Health URL answered 401',
    });
    const broken = make(s, () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    });
    expect((await broken.source.health()).status).toBe('unhealthy');
  });
});

describe('poll-http watermark', () => {
  const ev = (id: string, occurredAt: string): EventDraft => ({
    type: 'poll-http.x.y',
    occurredAt,
    artifact: { kind: 'k', id },
    attributes: {},
    dedupeKey: `k:${id}:${occurredAt}`,
  });

  it('round-trips and tolerates foreign values', () => {
    const state = { cursor: 'c1', at: '2026-01-01T00:00:00.000Z', seen: ['a'] };
    expect(decodeWatermark(encodeWatermark(state), undefined)).toEqual(state);
    expect(decodeWatermark('{"v":2}', undefined)).toEqual({
      cursor: '{"v":2}',
      at: null,
      seen: [],
    });
    expect(decodeWatermark(null, '12345')).toEqual({ cursor: '12345', at: null, seen: [] });
  });

  it('drops events before the boundary and boundary events already seen', () => {
    const at = '2026-01-01T00:00:10.000Z';
    const result = selectNew(
      [
        ev('late', '2026-01-01T00:00:11.000Z'),
        ev('old', '2026-01-01T00:00:09.000Z'),
        ev('a', at),
        ev('b', at),
      ],
      { cursor: at, at, seen: [`k:a:${at}`] },
    );
    expect(result.events.map((e) => e.artifact.id)).toEqual(['b', 'late']);
    expect(result.at).toBe('2026-01-01T00:00:11.000Z');
    expect(result.seen).toEqual(['k:late:2026-01-01T00:00:11.000Z']);
  });

  it('accumulates seen keys while the boundary stays put, and removes in-batch duplicates', () => {
    const at = '2026-01-01T00:00:10.000Z';
    const result = selectNew([ev('b', at), ev('b', at)], { cursor: at, at, seen: [`k:a:${at}`] });
    expect(result.events).toHaveLength(1);
    expect(result.seen).toEqual([`k:a:${at}`, `k:b:${at}`]);
  });
});
