import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import webhookPlugin from '@ai-switchboard/source-webhook';
import { definePlugin } from '@ai-switchboard/sdk';

import type {
  LastDeliveryResponse,
  SourceDetail,
  SourcePreviewResponse,
} from '../../src/api/contract.js';
import { eventRaw } from '../../src/db/schema.js';
import { createApiHarness, type ApiHarness } from '../helpers/api.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const SECRET = 'fixture-preview-secret-value';
const reason = 'integration test';

/** A pull-only source type: there is no delivery to preview. */
const pollPlugin = definePlugin({
  id: 'test-poll-plugin',
  displayName: 'Test poll plugin',
  sources: [
    {
      id: 'test-poll',
      displayName: 'Test poll',
      mode: 'pull',
      settingsSchema: { type: 'object' },
      eventTypes: [
        {
          type: 'test-poll.thing.seen',
          title: 'Seen',
          description: 'Seen',
          attributes: { type: 'object', properties: {} },
          examples: [{}],
        },
      ],
      create: () => ({
        poll: () => Promise.resolve({ events: [], watermark: 'w' }),
        health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date().toISOString() }),
      }),
    },
  ],
});

let tdb: TestDatabase;
let h: ApiHarness;

beforeAll(async () => {
  process.env.PREVIEW_WEBHOOK_SECRET = SECRET;
  tdb = await createTestDatabase();
  h = await createApiHarness(tdb, {
    plugins: [
      { name: '@ai-switchboard/source-webhook', version: '1.1.0', definition: webhookPlugin },
      { name: 'test-poll-plugin', version: '1.0.0', definition: pollPlugin },
    ],
  });
});

afterAll(async () => {
  await h.close();
  await tdb.destroy();
});

const issueBody = JSON.stringify({ issue: { id: 'ISS-7', priority: 'high' }, echo: SECRET });

function preview(body: unknown) {
  return h.request('POST', '/api/v1/sources/preview', { cookie: h.adminCookie, body });
}

const mappedSettings = {
  verification: 'hmac',
  secret: 'secret://env/PREVIEW_WEBHOOK_SECRET',
  mappingMode: 'mapped',
  rules: [
    {
      type: 'webhook.issue.created',
      title: 'Issue created',
      when: { path: 'headers.x-event-type', equals: 'issue.created' },
      artifactKind: 'issue',
      artifactIdPath: 'body.issue.id',
      attributes: [
        { name: 'priority', path: 'body.issue.priority', type: 'string' },
        { name: 'echo', path: 'body.echo', type: 'string' },
      ],
    },
  ],
};

describe('POST /sources/preview', () => {
  it('builds a throwaway instance, parses without verifying, and never echoes a secret', async () => {
    const res = await preview({
      typeId: 'webhook',
      settings: mappedSettings,
      request: { body: issueBody, headers: { 'X-Event-Type': 'issue.created' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json<SourcePreviewResponse>();
    expect(res.body).not.toContain(SECRET);
    expect(out.declaredTypes.map((t) => t.type)).toEqual(['webhook.issue.created']);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      type: 'webhook.issue.created',
      artifact: { kind: 'issue', id: 'ISS-7' },
      attributes: { priority: 'high', echo: '[redacted]' },
      valid: false,
    });
    // The core's own check still flags the leak, as ingest would.
    expect(out.events[0]?.problems).toEqual(['an attribute contains a secret value']);
    expect(out.errors).toEqual([
      'Event 1 (webhook.issue.created) would be stored as invalid: an attribute contains a secret value',
    ]);
  });

  it('explains a delivery that produced nothing with the plugin’s notes', async () => {
    const res = await preview({
      typeId: 'webhook',
      settings: mappedSettings,
      request: { body: issueBody, headers: { 'x-event-type': 'issue.closed' } },
    });
    const out = res.json<SourcePreviewResponse>();
    expect(out.events).toEqual([]);
    expect(out.errors).toEqual([]);
    expect(out.notes[0]).toMatch(/^No rule matched/);
  });

  it('works with no settings at all (quick mode, unauthenticated)', async () => {
    const res = await preview({
      typeId: 'webhook',
      settings: { verification: 'none' },
      request: { body: '{"id": 5, "action": "opened", "pr": {"number": 9}}' },
    });
    const out = res.json<SourcePreviewResponse>();
    expect(out.errors).toEqual([]);
    expect(out.events).toEqual([
      expect.objectContaining({
        type: 'webhook.request.received',
        artifact: { kind: 'webhook.request', id: '5' },
        attributes: { id: 5, action: 'opened', pr_number: 9 },
        valid: true,
        problems: [],
      }),
    ]);
  });

  it('reports settings that do not validate, a secret that does not resolve, and a bad mapping', async () => {
    const invalid = await preview({
      typeId: 'webhook',
      settings: { verification: 'none', mappingMode: 'mapped' },
      request: { body: '{}' },
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json<SourcePreviewResponse>().errors).toEqual([
      "Settings: must have required property 'rules'",
    ]);

    const literal = await preview({
      typeId: 'webhook',
      settings: { verification: 'hmac', secret: 'a-literal-value' },
      request: { body: '{}' },
    });
    expect(literal.json<SourcePreviewResponse>().errors).toEqual([
      'Settings: secret must be a secret://<provider>/<name> reference',
    ]);

    const missing = await preview({
      typeId: 'webhook',
      settings: { verification: 'hmac', secret: 'secret://env/NOT_SET_ANYWHERE' },
      request: { body: '{}' },
    });
    expect(missing.json<SourcePreviewResponse>().errors[0]).toMatch(
      /^A secret reference could not be resolved: .*NOT_SET_ANYWHERE/,
    );

    const badMapping = await preview({
      typeId: 'webhook',
      settings: {
        verification: 'none',
        mappingMode: 'jsonata',
        eventTypes: [{ type: 'webhook.a.b', title: 'A', attributes: [] }],
        mapping: '{ "type": ',
      },
      request: { body: '{}' },
    });
    expect(badMapping.json<SourcePreviewResponse>().errors[0]).toMatch(
      /^These settings do not build an instance: mapping does not compile/,
    );

    const throws = await preview({
      typeId: 'webhook',
      settings: {
        verification: 'none',
        mappingMode: 'jsonata',
        eventTypes: [{ type: 'webhook.a.b', title: 'A', attributes: [] }],
        mapping: "$error('boom')",
      },
      request: { body: '{}' },
    });
    expect(throws.json<SourcePreviewResponse>().errors[0]).toMatch(
      /^The sample could not be parsed: mapping failed: boom/,
    );
  });

  it('refuses a pull-only type (422), an unknown type (404) and a viewer (403)', async () => {
    const pull = await preview({ typeId: 'test-poll', settings: {}, request: { body: '{}' } });
    expect(pull.statusCode).toBe(422);
    const unknown = await preview({ typeId: 'nope', settings: {}, request: { body: '{}' } });
    expect(unknown.statusCode).toBe(404);

    const token = await h.request('POST', '/api/v1/tokens', {
      cookie: h.adminCookie,
      body: { name: 'preview-viewer', role: 'viewer', reason },
    });
    expect(token.statusCode, token.body).toBe(201);
    const forbidden = await h.request('POST', '/api/v1/sources/preview', {
      token: token.json<{ secret: string }>().secret,
      body: { typeId: 'webhook', settings: {}, request: { body: '{}' } },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe('an existing source', () => {
  let source: SourceDetail;

  beforeAll(async () => {
    const res = await h.request('POST', '/api/v1/sources', {
      cookie: h.adminCookie,
      body: { typeId: 'webhook', name: 'Tracker', settings: mappedSettings, reason },
    });
    expect(res.statusCode, res.body).toBe(201);
    source = res.json<SourceDetail>();
  });

  it('keeps the stored secret reference for a secret field left empty', async () => {
    const { secret: _secret, ...withoutSecret } = mappedSettings;
    const res = await preview({
      typeId: 'webhook',
      sourceId: source.id,
      settings: withoutSecret,
      request: { body: issueBody, headers: { 'x-event-type': 'issue.created' } },
    });
    const out = res.json<SourcePreviewResponse>();
    expect(out.events).toHaveLength(1);
    expect(res.body).not.toContain(SECRET);
    const wrongType = await preview({
      typeId: 'test-open',
      sourceId: source.id,
      settings: {},
      request: { body: '{}' },
    });
    expect(wrongType.statusCode).toBe(422);
    const missing = await preview({
      typeId: 'webhook',
      sourceId: randomUUID(),
      settings: {},
      request: { body: '{}' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('returns the newest stored delivery with sensitive headers redacted', async () => {
    const url = `/api/v1/sources/${source.id}/last-delivery`;
    expect((await h.request('GET', url, { cookie: h.adminCookie })).statusCode).toBe(404);

    const insert = (at: string, body: string, headers: Record<string, string>) =>
      h.ctx.db.insert(eventRaw).values({
        ref: randomUUID(),
        sourceId: source.id,
        body: Buffer.from(body),
        headers,
        receivedAt: new Date(at),
        verify: 'ok',
      });
    await insert('2026-03-02T09:00:00Z', '{"old": true}', { 'x-event-type': 'issue.created' });
    await insert('2026-03-02T09:30:00Z', '{"new": true}', {
      'x-event-type': 'issue.updated',
      'x-signature-256': 'sha256=abc',
      'x-api-key': 'k',
    });
    // Newer, but not a delivery a person could reuse: a test event and a rejected one.
    await insert('2026-03-02T09:40:00Z', '[]', { 'x-switchboard-origin': 'test' });
    await h.ctx.db.insert(eventRaw).values({
      ref: randomUUID(),
      sourceId: source.id,
      body: Buffer.alloc(0),
      headers: {},
      receivedAt: new Date('2026-03-02T09:50:00Z'),
      verify: 'rejected:signature mismatch',
    });

    const res = await h.request('GET', url, { cookie: h.adminCookie });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<LastDeliveryResponse>()).toEqual({
      receivedAt: '2026-03-02T09:30:00.000Z',
      body: '{"new": true}',
      headers: {
        'x-event-type': 'issue.updated',
        'x-signature-256': '[redacted]',
        'x-api-key': '[redacted]',
      },
    });
    const bogus = await h.request('GET', `/api/v1/sources/${randomUUID()}/last-delivery`, {
      cookie: h.adminCookie,
    });
    expect(bogus.statusCode).toBe(404);
  });
});
