import { describe, expect, it } from 'vitest';

import { signHmac, validatePlugin, type RawRequest, type Settings } from '@ai-switchboard/sdk';
import {
  createTestContext,
  rawRequest,
  runConformance,
  sourceConformanceChecks,
  type SourceFixtures,
} from '@ai-switchboard/sdk/testing';

import finished from './__fixtures__/deploy-finished.json' with { type: 'json' };
import started from './__fixtures__/deploy-started.json' with { type: 'json' };
import baseSettings from './__fixtures__/settings.json' with { type: 'json' };
import plugin from './plugin.js';
import { webhookSource } from './source.js';

const SECRET = 'fixture-secret';
const RECEIVED_AT = '2026-09-27T10:14:07.000Z';

interface Fixture {
  headers: Record<string, string>;
  body: unknown;
}

function withBody(fixture: Fixture, patch: (body: Record<string, unknown>) => void): Fixture {
  const body = structuredClone(fixture.body) as Record<string, unknown>;
  patch(body);
  return { ...fixture, body };
}

function signed(
  fixture: Fixture,
  extraHeaders: Record<string, string | undefined> = {},
): RawRequest {
  const body = JSON.stringify(fixture.body);
  return rawRequest({
    headers: {
      ...fixture.headers,
      'x-signature-256': `sha256=${signHmac({ secret: SECRET, payload: body })}`,
      ...extraHeaders,
    },
    body,
    receivedAt: RECEIVED_AT,
  });
}

function settings(overrides: Settings = {}): Settings {
  return { ...structuredClone(baseSettings), ...overrides };
}

function make(s: Settings = settings()) {
  return webhookSource.create(s, createTestContext());
}

const redelivery = signed(finished, { 'x-delivery-id': 'a-different-delivery-id' });
const secondDeploy = signed(
  withBody(finished, (b) => {
    b.deployment = { ...(b.deployment as object), updated_at: '2026-09-27T11:02:40Z' };
  }),
);

const hmacFixtures: SourceFixtures = {
  settings: settings(),
  secrets: [SECRET],
  push: {
    deliveries: [signed(finished), signed(started)],
    sameChange: [signed(finished), redelivery],
    differentChange: [signed(finished), secondDeploy],
    wrongSignature: signed(finished, { 'x-signature-256': `sha256=${'0'.repeat(64)}` }),
    missingHeader: signed(finished, { 'x-signature-256': undefined }),
  },
};

runConformance('webhook source (hmac)', sourceConformanceChecks(webhookSource, hmacFixtures), {
  describe,
  it,
});

runConformance(
  'webhook source (shared secret)',
  sourceConformanceChecks(webhookSource, {
    ...hmacFixtures,
    settings: settings({ verification: 'shared_secret' }),
    push: {
      ...hmacFixtures.push!,
      deliveries: [signed(finished, { 'x-webhook-secret': SECRET })],
      sameChange: [
        signed(finished, { 'x-webhook-secret': SECRET }),
        signed(finished, { 'x-webhook-secret': SECRET, 'x-delivery-id': 'retry-2' }),
      ],
      wrongSignature: signed(finished, { 'x-webhook-secret': 'not-the-secret' }),
      missingHeader: signed(finished),
    },
  }),
  { describe, it },
);

runConformance(
  'webhook source (unauthenticated)',
  sourceConformanceChecks(webhookSource, {
    ...hmacFixtures,
    settings: settings({ verification: 'none', secret: undefined }),
  }),
  { describe, it },
);

describe('webhook plugin manifest', () => {
  it('validates and declares no network access', () => {
    expect(validatePlugin(plugin)).toEqual([]);
    expect(plugin.capabilities.network).toEqual([]);
    expect(webhookSource.dynamicEventTypes).toBe(true);
    expect(webhookSource.allowsUnauthenticated).toBe(true);
  });
});

describe('webhook instanceEventTypes', () => {
  it('builds flat attribute schemas and examples from the settings', () => {
    const specs = webhookSource.instanceEventTypes!(settings());
    expect(specs.map((s) => s.type)).toEqual(['webhook.deploy.finished', 'webhook.deploy.started']);
    const [finishedSpec, startedSpec] = specs;
    expect(finishedSpec!.attributes).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        service: { type: 'string', description: 'Service name' },
        environment: { type: 'string' },
        status: { type: 'string' },
        durationSeconds: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        rollback: { type: 'boolean' },
      },
    });
    // The given example is used where present; placeholders fill the rest.
    expect(finishedSpec!.examples).toEqual([
      {
        service: 'api',
        environment: 'production',
        status: 'success',
        durationSeconds: 0,
        tags: ['example'],
        rollback: false,
      },
    ]);
    expect(startedSpec!.description).toBe('Deploy started');
  });

  it('keeps the first of duplicate types and returns nothing for invalid settings', () => {
    const s = settings();
    const defs = s.eventTypes as { type: string; title: string }[];
    defs.push({ ...defs[0]!, title: 'Duplicate' });
    const specs = webhookSource.instanceEventTypes!(s);
    expect(specs.filter((x) => x.type === 'webhook.deploy.finished')).toHaveLength(1);
    expect(specs[0]!.title).toBe('Deploy finished');
    expect(webhookSource.instanceEventTypes!({ mapping: 'x' })).toEqual([]);
  });

  it('does not mutate the settings it is given', () => {
    const s = settings();
    const before = JSON.stringify(s);
    webhookSource.instanceEventTypes!(s);
    make(s);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('webhook create', () => {
  it('rejects a mapping that does not compile', () => {
    expect(() => make(settings({ mapping: '{ "type": ' }))).toThrow(/mapping does not compile/);
  });

  it('requires a secret unless verification is none', () => {
    expect(() => make(settings({ secret: undefined }))).toThrow(/Invalid webhook settings/);
    expect(() => make(settings({ secret: '' }))).toThrow(/Invalid webhook settings/);
    expect(() => make(settings({ verification: 'none', secret: undefined }))).not.toThrow();
  });

  it('rejects event types outside the webhook namespace', () => {
    const s = settings();
    (s.eventTypes as { type: string }[])[0]!.type = 'github.pr.opened';
    expect(() => make(s)).toThrow(/Invalid webhook settings/);
  });

  it('omits verify entirely when verification is none', () => {
    expect('verify' in make(settings({ verification: 'none', secret: undefined }))).toBe(false);
    expect(typeof make().verify).toBe('function');
  });
});

describe('webhook verify', () => {
  it('accepts a correct signature and rejects a tampered body', () => {
    const src = make();
    const good = signed(finished);
    expect(src.verify!(good)).toEqual({ ok: true });
    const tampered = { ...good, body: Buffer.from(good.body.toString().replace('184', '185')) };
    expect(src.verify!(tampered)).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('names the missing header', () => {
    expect(make().verify!(signed(finished, { 'x-signature-256': undefined }))).toEqual({
      ok: false,
      reason: 'missing x-signature-256 header',
    });
  });

  it('honours a custom header, prefix, algorithm and encoding', () => {
    const src = make(
      settings({
        signatureHeader: 'X-Hook-Signature',
        signaturePrefix: '',
        algorithm: 'sha1',
        signatureEncoding: 'base64',
      }),
    );
    const body = JSON.stringify(finished.body);
    const sig = signHmac({ secret: SECRET, payload: body, algorithm: 'sha1', encoding: 'base64' });
    expect(src.verify!(rawRequest({ headers: { 'x-hook-signature': sig }, body })).ok).toBe(true);
    const sha256 = signHmac({ secret: SECRET, payload: body, encoding: 'base64' });
    expect(src.verify!(rawRequest({ headers: { 'x-hook-signature': sha256 }, body })).ok).toBe(
      false,
    );
  });

  it('rejects a signature without the configured prefix', () => {
    const body = JSON.stringify(finished.body);
    const bare = signHmac({ secret: SECRET, payload: body });
    expect(make().verify!(rawRequest({ headers: { 'x-signature-256': bare }, body })).ok).toBe(
      false,
    );
  });

  it('checks a shared-secret header in constant time and never throws on odd input', () => {
    const src = make(settings({ verification: 'shared_secret', sharedSecretHeader: 'X-Token' }));
    expect(src.verify!(rawRequest({ headers: { 'x-token': SECRET }, body: '{}' })).ok).toBe(true);
    expect(
      src.verify!(rawRequest({ headers: { 'x-token': 'fixture-secreT' }, body: '{}' })),
    ).toEqual({ ok: false, reason: 'secret mismatch' });
    expect(src.verify!(rawRequest({ headers: { 'x-token': '' }, body: '{}' })).ok).toBe(false);
    expect(src.verify!(rawRequest({ headers: { 'x-token': '\u0000'.repeat(3) } })).ok).toBe(false);
  });
});

describe('webhook parse', () => {
  it('maps a delivery to one event with coerced, declared attributes only', async () => {
    const events = await make().parse!(signed(finished));
    expect(events).toEqual([
      {
        type: 'webhook.deploy.finished',
        occurredAt: '2026-09-27T10:14:06.000Z',
        artifact: {
          kind: 'deploy',
          id: 'dep_48213',
          url: 'https://deploys.example.com/api/dep_48213',
          version: '2026-09-27T10:14:06Z',
        },
        attributes: {
          service: 'api',
          environment: 'production',
          status: 'success',
          durationSeconds: 184,
          tags: ['team:payments', 'region:us-east-1'],
          rollback: false,
        },
        deliveryId: '7f3a9c1e-2b44-4d0a-9d4f-8e1b2a6c5d01',
        dedupeKey: 'webhook.deploy.finished:deploy:dep_48213:2026-09-27T10:14:06Z',
      },
    ]);
  });

  it('drops mapping results whose type is not declared', async () => {
    const queued = withBody(finished, (b) => {
      b.status = 'queued';
    });
    expect(await make().parse!(signed(queued))).toEqual([]);
  });

  it('emits one event per array element and skips elements without a usable artifact', async () => {
    const src = make(
      settings({
        mapping:
          "body.deploys.{ 'type': 'webhook.deploy.started', 'artifact': { 'kind': 'deploy', 'id': id }, 'attributes': { 'service': service } }",
      }),
    );
    const req = signed({
      headers: { 'content-type': 'application/json' },
      body: {
        deploys: [{ id: 'd1', service: 'api' }, { service: 'web' }, { id: 7, service: 'db' }],
      },
    });
    const events = await src.parse!(req);
    expect(events.map((e) => [e.artifact.id, e.attributes.service])).toEqual([
      ['d1', 'api'],
      ['7', 'db'],
    ]);
    // No version and no delivery id: the key ends empty, and occurredAt falls back to receipt.
    expect(events[0]!.dedupeKey).toBe('webhook.deploy.started:deploy:d1:');
    expect(events[0]!.occurredAt).toBe(RECEIVED_AT);
  });

  it('uses the mapped deliveryId over the header, and the header when the mapping has none', async () => {
    const src = make(
      settings({
        mapping:
          "{ 'type': 'webhook.deploy.started', 'artifact': { 'kind': 'deploy', 'id': body.id }, 'attributes': {}, 'deliveryId': body.eventId }",
      }),
    );
    const withId = await src.parse!(
      signed({ headers: { 'x-delivery-id': 'hdr-1' }, body: { id: 'd1', eventId: 'evt-9' } }),
    );
    expect(withId[0]!.deliveryId).toBe('evt-9');
    expect(withId[0]!.dedupeKey).toBe('webhook.deploy.started:deploy:d1:evt-9');
    const fromHeader = await src.parse!(
      signed({ headers: { 'x-delivery-id': 'hdr-1' }, body: { id: 'd1' } }),
    );
    expect(fromHeader[0]!.dedupeKey).toBe('webhook.deploy.started:deploy:d1:hdr-1');
  });

  it('reads the delivery id from a configured header', async () => {
    const src = make(settings({ deliveryIdHeader: 'X-Request-Id' }));
    const events = await src.parse!(signed(started, { 'x-request-id': 'req-77' }));
    expect(events[0]!.deliveryId).toBe('req-77');
  });

  it('coerces forgivingly and drops values it cannot represent', async () => {
    const src = make(
      settings({
        mapping:
          "{ 'type': 'webhook.deploy.finished', 'artifact': { 'kind': 'deploy', 'id': 'd1', 'version': 3 }, 'attributes': { 'service': 42, 'durationSeconds': '12.5', 'rollback': 'true', 'tags': 'solo', 'status': { 'nested': true }, 'environment': null }, 'occurredAt': 1790000000 }",
      }),
    );
    const [ev] = await src.parse!(signed({ headers: {}, body: {} }));
    expect(ev!.attributes).toEqual({
      service: '42',
      durationSeconds: 12.5,
      rollback: true,
      tags: ['solo'],
    });
    expect(ev!.artifact.version).toBe('3');
    expect(ev!.occurredAt).toBe(new Date(1790000000 * 1000).toISOString());
  });

  it('pins $now() and $millis() to the delivery receipt time and refuses $random()', async () => {
    const mapping = (attrs: string) =>
      `{ 'type': 'webhook.deploy.started', 'artifact': { 'kind': 'deploy', 'id': 'd1' }, 'attributes': ${attrs} }`;
    const src = make(
      settings({ mapping: mapping("{ 'service': $now() & '|' & $string($millis()) }") }),
    );
    const [ev] = await src.parse!(signed({ headers: {}, body: {} }));
    expect(ev!.attributes.service).toBe(`${RECEIVED_AT}|${Date.parse(RECEIVED_AT)}`);
    const random = make(settings({ mapping: mapping("{ 'service': $string($random()) }") }));
    await expect(random.parse!(signed({ headers: {}, body: {} }))).rejects.toThrow(/\$random\(\)/);
  });

  it('hides credential headers from the mapping but exposes the rest and the query', async () => {
    const src = make(
      settings({
        mapping:
          "{ 'type': 'webhook.deploy.started', 'artifact': { 'kind': 'deploy', 'id': 'd1' }, 'attributes': { 'service': $join([headers.'x-signature-256', headers.authorization, headers.'user-agent', query.env], ',') } }",
      }),
    );
    const req = signed({
      headers: { authorization: 'Bearer fixture-token', 'user-agent': 'Hookshot' },
      body: {},
    });
    const [ev] = await src.parse!({ ...req, query: { env: 'staging' } });
    expect(ev!.attributes.service).toBe('Hookshot,staging');
  });

  it('parses form-encoded bodies into an object', async () => {
    const src = make(
      settings({
        verification: 'none',
        secret: undefined,
        mapping:
          "{ 'type': 'webhook.deploy.started', 'artifact': { 'kind': 'deploy', 'id': body.id }, 'attributes': { 'service': body.service } }",
      }),
    );
    const [ev] = await src.parse!(
      rawRequest({
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'id=d9&service=billing',
      }),
    );
    expect(ev!.artifact.id).toBe('d9');
    expect(ev!.attributes.service).toBe('billing');
  });

  it('turns an evaluation error into a MappingError', async () => {
    const src = make(settings({ mapping: "$error('boom')" }));
    await expect(src.parse!(signed(finished))).rejects.toMatchObject({
      name: 'MappingError',
      message: expect.stringContaining('boom') as string,
    });
  });

  it('returns no events when the mapping yields nothing', async () => {
    const src = make(settings({ mapping: 'body.missing' }));
    expect(await src.parse!(signed(finished))).toEqual([]);
  });
});

describe('webhook health', () => {
  it('reports unknown with a timestamp from the context clock', async () => {
    const now = new Date('2026-09-27T12:00:00Z');
    const src = webhookSource.create(settings(), createTestContext({ now: () => now }));
    expect(await src.health()).toEqual({
      status: 'unknown',
      message: expect.any(String) as string,
      checkedAt: now.toISOString(),
    });
  });
});
