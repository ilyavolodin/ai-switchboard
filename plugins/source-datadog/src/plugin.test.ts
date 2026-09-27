import { describe, expect, it } from 'vitest';

import { validatePlugin, type RawRequest, type Settings } from '@ai-switchboard/sdk';
import {
  createStubHttp,
  createTestContext,
  rawRequest,
  runConformance,
  sourceConformanceChecks,
  type StubHandler,
} from '@ai-switchboard/sdk/testing';

import apiMonitor from './__fixtures__/api-monitor.json' with { type: 'json' };
import noData from './__fixtures__/no-data.json' with { type: 'json' };
import recovered from './__fixtures__/recovered.json' with { type: 'json' };
import renotify from './__fixtures__/renotify.json' with { type: 'json' };
import triggered from './__fixtures__/triggered.json' with { type: 'json' };
import warn from './__fixtures__/warn.json' with { type: 'json' };
import { transitionVerb } from './parse.js';
import plugin from './plugin.js';
import { datadogSource } from './source.js';

const SECRET = 'fixture-secret-0123456789';
const API_KEY = 'fixture-dd-api-key';
const APP_KEY = 'fixture-dd-app-key';
const NOW = new Date('2026-09-27T12:00:00.000Z');

type Payload = Record<string, string>;

function deliver(
  payload: Payload,
  overrides: Payload = {},
  headers: Record<string, string | undefined> = {},
): RawRequest {
  return rawRequest({
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Datadog Webhook',
      'x-switchboard-secret': SECRET,
      ...headers,
    },
    body: JSON.stringify({ ...payload, ...overrides }),
    receivedAt: NOW.toISOString(),
  });
}

const settings: Settings = { sharedSecret: SECRET, apiKey: API_KEY, appKey: APP_KEY };

function datadogApi(site = 'datadoghq.com'): StubHandler {
  return (req) => {
    if (req.url.hostname !== `api.${site}`) return { status: 500, body: 'wrong host' };
    if (req.url.pathname === '/api/v1/validate') return { json: { valid: true } };
    if (req.url.pathname === '/api/v1/monitor/148275309') return { json: apiMonitor };
    return { status: 404, json: { errors: ['Monitor not found'] } };
  };
}

function make(s: Settings = settings, handler: StubHandler = datadogApi()) {
  const stub = createStubHttp(handler, plugin.capabilities.network);
  const source = datadogSource.create(s, createTestContext({ http: stub.client, now: () => NOW }));
  return { source, calls: stub.calls };
}

const parse = (req: RawRequest, s: Settings = settings) => make(s).source.parse!(req);

runConformance(
  'datadog source',
  sourceConformanceChecks(datadogSource, {
    settings,
    secrets: [SECRET, API_KEY, APP_KEY],
    http: datadogApi(),
    now: () => NOW,
    push: {
      deliveries: [triggered, renotify, recovered, noData, warn].map((p) => deliver(p)),
      // Datadog retries a 5xx with the same payload; a second delivery in the same cycle collapses.
      sameChange: [deliver(triggered), deliver(triggered, { id: '7716548234011234999' })],
      differentChange: [
        deliver(triggered),
        deliver(triggered, { alertCycleKey: '7716548234099990000' }),
      ],
      wrongSignature: deliver(
        triggered,
        {},
        { 'x-switchboard-secret': 'fixture-secret-0123456780' },
      ),
      missingHeader: deliver(triggered, {}, { 'x-switchboard-secret': undefined }),
    },
    resolveNotFound: { kind: 'datadog.monitor', id: '999' },
  }),
  { describe, it },
);

describe('datadog manifest', () => {
  it('validates and declares every site’s API host', () => {
    expect(validatePlugin(plugin)).toEqual([]);
    expect(plugin.capabilities.network).toEqual([
      'api.datadoghq.com',
      'api.datadoghq.eu',
      'api.us3.datadoghq.com',
      'api.us5.datadoghq.com',
      'api.ap1.datadoghq.com',
    ]);
  });

  it('insists on a long shared secret', () => {
    expect(() => make({ sharedSecret: 'short' })).toThrow(/Invalid datadog settings/);
  });
});

describe('datadog verify', () => {
  it('checks the shared-secret header and names a missing one', () => {
    const { source } = make();
    expect(source.verify!(deliver(triggered))).toEqual({ ok: true });
    expect(source.verify!(deliver(triggered, {}, { 'x-switchboard-secret': undefined }))).toEqual({
      ok: false,
      reason: 'missing x-switchboard-secret header',
    });
    expect(
      source.verify!(deliver(triggered, {}, { 'x-switchboard-secret': `${SECRET}x` })),
    ).toEqual({
      ok: false,
      reason: 'secret mismatch',
    });
  });

  it('honours a custom header name, case-insensitively', () => {
    const { source } = make({ ...settings, headerName: 'X-DD-Token' });
    expect(
      source.verify!(
        deliver(triggered, {}, { 'x-switchboard-secret': undefined, 'X-DD-Token': SECRET }),
      ).ok,
    ).toBe(true);
    expect(source.verify!(deliver(triggered)).ok).toBe(false);
  });
});

describe('datadog parse', () => {
  it('maps a triggered alert', async () => {
    expect(await parse(deliver(triggered))).toEqual([
      {
        type: 'datadog.monitor.triggered',
        occurredAt: '2026-09-27T10:15:00.000Z',
        artifact: {
          kind: 'datadog.monitor',
          id: '148275309',
          url: 'https://app.datadoghq.com/monitors/148275309?group=env%3Aprod%2Cservice%3Aapi&from_ts=1790503500000&to_ts=1790504700000&event_id=7716548234011234567',
        },
        attributes: {
          monitorId: '148275309',
          title: '[Triggered on {env:prod,service:api}] [P1] API 5xx rate above 2%',
          transition: 'Triggered',
          tags: ['env:prod', 'monitor', 'service:api', 'team:payments'],
          alertType: 'error',
          priority: 'P1',
          metric: 'trace.http.request.errors',
          scope: 'env:prod,service:api',
          orgId: '421337',
        },
        deliveryId: '7716548234011230001',
        dedupeKey: 'datadog.monitor.triggered:datadog.monitor:148275309:7716548234011230001',
      },
    ]);
  });

  it('drops unsubstituted template variables and keeps the message body out', async () => {
    const [ev] = await parse(deliver(triggered));
    expect(ev!.attributes.hostname).toBeUndefined();
    expect(JSON.stringify(ev!.attributes)).not.toContain('Runbook');
    const [withHost] = await parse(deliver(warn));
    expect(withHost!.attributes.hostname).toBe('api-prod-7f9c');
  });

  it.each([
    [recovered, 'datadog.monitor.recovered'],
    [renotify, 'datadog.monitor.renotify'],
    [noData, 'datadog.monitor.no_data'],
    [warn, 'datadog.monitor.warn'],
  ])('maps each transition to its event type', async (payload, type) => {
    const [ev] = await parse(deliver(payload));
    expect(ev!.type).toBe(type);
    expect(ev!.artifact.version).toBeUndefined();
  });

  it('maps Datadog’s transition spellings', () => {
    expect(
      [
        'Triggered',
        'Recovered',
        'Warn',
        'No Data',
        'Re-Triggered',
        'Re-Warn',
        'Re-No Data',
        'Renotify',
        'Warn Recovered',
        'no_data',
        'Something New',
      ].map(transitionVerb),
    ).toEqual([
      'triggered',
      'recovered',
      'warn',
      'no_data',
      'renotify',
      'renotify',
      'renotify',
      'renotify',
      'recovered',
      'no_data',
      'triggered',
    ]);
  });

  it('keeps an unknown transition visible as triggered with the raw value', async () => {
    const [ev] = await parse(deliver(triggered, { transition: 'Muted' }));
    expect(ev!.type).toBe('datadog.monitor.triggered');
    expect(ev!.attributes.transition).toBe('Muted');
  });

  it('collapses renotifications within one alert cycle but not across cycles', async () => {
    const [a] = await parse(deliver(renotify));
    const [b] = await parse(
      deliver(renotify, { id: '7716548234011400000', date: '1790507700000' }),
    );
    const [c] = await parse(deliver(renotify, { alertCycleKey: '7716548234055550000' }));
    expect(a!.dedupeKey).toBe(b!.dedupeKey);
    expect(a!.dedupeKey).not.toBe(c!.dedupeKey);
  });

  it('falls back to the event id, then to the receipt time, when fields are missing', async () => {
    const [ev] = await parse(
      deliver(triggered, { alertCycleKey: '$ALERT_CYCLE_KEY', date: '', lastUpdated: '' }),
    );
    expect(ev!.deliveryId).toBe('7716548234011234567');
    expect(ev!.occurredAt).toBe(NOW.toISOString());
  });

  it('accepts epoch seconds and numeric JSON values', async () => {
    const req = rawRequest({ body: { ...triggered, alertId: 148275309, date: 1790504100 } });
    const [ev] = await parse(req);
    expect(ev!.artifact.id).toBe('148275309');
    expect(ev!.occurredAt).toBe('2026-09-27T10:15:00.000Z');
  });

  it('handles empty tags and yields nothing without a monitor id or transition', async () => {
    const [ev] = await parse(deliver(triggered, { tags: '' }));
    expect(ev!.attributes.tags).toEqual([]);
    expect(await parse(deliver(triggered, { alertId: '$ALERT_ID' }))).toEqual([]);
    expect(await parse(deliver(triggered, { transition: '' }))).toEqual([]);
    expect(await parse(rawRequest({ body: 'not json' }))).toEqual([]);
  });
});

describe('datadog resolve', () => {
  it('returns live monitor state with keys from settings', async () => {
    const { source, calls } = make();
    expect(await source.resolve!({ kind: 'datadog.monitor', id: '148275309' })).toEqual({
      ref: {
        kind: 'datadog.monitor',
        id: '148275309',
        url: 'https://app.datadoghq.com/monitors/148275309',
      },
      name: 'API 5xx rate above 2%',
      overallState: 'Alert',
      tags: ['env:prod', 'service:api', 'team:payments'],
      priority: 'P1',
      url: 'https://app.datadoghq.com/monitors/148275309',
    });
    expect(calls[0]!.headers['dd-api-key']).toBe(API_KEY);
    expect(calls[0]!.headers['dd-application-key']).toBe(APP_KEY);
  });

  it('uses the configured site for the API and the monitor link', async () => {
    const { source, calls } = make(
      { ...settings, site: 'us5.datadoghq.com' },
      datadogApi('us5.datadoghq.com'),
    );
    const snap = await source.resolve!({ kind: 'datadog.monitor', id: '148275309' });
    expect(calls[0]!.url.hostname).toBe('api.us5.datadoghq.com');
    expect(snap!.url).toBe('https://us5.datadoghq.com/monitors/148275309');
    const eu = make({ ...settings, site: 'datadoghq.eu' }, datadogApi('datadoghq.eu'));
    expect((await eu.source.resolve!({ kind: 'datadog.monitor', id: '148275309' }))!.url).toBe(
      'https://app.datadoghq.eu/monitors/148275309',
    );
  });

  it('returns null for 404 or a non-numeric id, and throws without keys or on refusal', async () => {
    const { source, calls } = make();
    expect(await source.resolve!({ kind: 'datadog.monitor', id: '999' })).toBeNull();
    expect(await source.resolve!({ kind: 'datadog.monitor', id: '../validate' })).toBeNull();
    expect(calls).toHaveLength(1);
    await expect(
      make({ sharedSecret: SECRET }).source.resolve!({ kind: 'datadog.monitor', id: '1' }),
    ).rejects.toThrow(/apiKey and appKey/);
    const forbidden = make(settings, () => ({ status: 403, json: { errors: ['Forbidden'] } }));
    await expect(forbidden.source.resolve!({ kind: 'datadog.monitor', id: '1' })).rejects.toThrow(
      'Datadog answered 403: Forbidden',
    );
  });
});

describe('datadog health', () => {
  it('is unknown without an API key and validates it otherwise', async () => {
    expect((await make({ sharedSecret: SECRET }).source.health()).status).toBe('unknown');
    expect(await make().source.health()).toEqual({
      status: 'healthy',
      message: 'API key valid on datadoghq.com',
      checkedAt: NOW.toISOString(),
    });
    const bad = make(settings, () => ({ status: 403, json: { errors: ['Forbidden'] } }));
    expect((await bad.source.health()).status).toBe('unhealthy');
  });
});
