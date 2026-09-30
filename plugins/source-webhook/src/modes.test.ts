import { describe, expect, it } from 'vitest';

import { signHmac, validateAgainst, type RawRequest, type Settings } from '@ai-switchboard/sdk';
import { createTestContext, rawRequest } from '@ai-switchboard/sdk/testing';

import finished from './__fixtures__/deploy-finished.json' with { type: 'json' };
import issue from './__fixtures__/issue-created.json' with { type: 'json' };
import legacySettings from './__fixtures__/settings.json' with { type: 'json' };
import mappedSettings from './__fixtures__/settings-mapped.json' with { type: 'json' };
import quickSettings from './__fixtures__/settings-quick.json' with { type: 'json' };
import { ruleDefinitions } from './modes/mapped.js';
import { quickArtifactKind } from './modes/quick.js';
import { mappingModeOf, settingsSchema, type MappedRule } from './settings.js';
import { webhookSource } from './source.js';

const RECEIVED_AT = '2026-09-27T10:14:07.000Z';

function delivery(
  fixture: { headers: Record<string, string>; body: unknown },
  headers: Record<string, string | undefined> = {},
): RawRequest {
  const body = JSON.stringify(fixture.body);
  return rawRequest({
    headers: {
      ...fixture.headers,
      'x-signature-256': `sha256=${signHmac({ secret: 'fixture-secret', payload: body })}`,
      ...headers,
    },
    body,
    receivedAt: RECEIVED_AT,
  });
}

function make(settings: Settings) {
  return webhookSource.create(structuredClone(settings), createTestContext());
}

describe('mapping mode selection and migration', () => {
  it('keeps instances saved before the modes on JSONata, and defaults new ones to quick', () => {
    expect(mappingModeOf(legacySettings)).toBe('jsonata');
    expect(mappingModeOf({})).toBe('quick');
    expect(mappingModeOf({ mappingMode: 'mapped', mapping: 'x' })).toBe('mapped');
    expect(mappingModeOf({ mappingMode: 'bogus' })).toBe('quick');
  });

  it('requires only what the effective mode needs', () => {
    const check = (s: Settings) => validateAgainst(settingsSchema, structuredClone(s)).valid;
    expect(check({ verification: 'none' })).toBe(true);
    expect(check(legacySettings)).toBe(true);
    // A legacy instance (mapping, no mode) still needs its event types.
    expect(check({ verification: 'none', mapping: 'x' })).toBe(false);
    expect(check({ verification: 'none', mappingMode: 'mapped' })).toBe(false);
    expect(check({ verification: 'none', mappingMode: 'jsonata' })).toBe(false);
    expect(check(mappedSettings)).toBe(true);
    expect(check({ ...quickSettings, artifactIdPath: 'deployment.id' })).toBe(false);
  });

  it('never writes a default mode, so saving a legacy instance keeps it on JSONata', () => {
    const copy = structuredClone(legacySettings) as Settings;
    validateAgainst(settingsSchema, copy);
    expect(copy).not.toHaveProperty('mappingMode');
    expect(mappingModeOf(copy)).toBe('jsonata');
  });
});

describe('quick mode', () => {
  it('makes one event per delivery with the body flattened into attributes', async () => {
    const [ev, ...rest] = await make(quickSettings).parse!(delivery(finished));
    expect(rest).toEqual([]);
    expect(ev).toEqual({
      type: 'webhook.deploy.finished',
      occurredAt: RECEIVED_AT,
      artifact: { kind: 'webhook.deploy', id: 'dep_48213', version: '2026-09-27T10:14:06Z' },
      attributes: {
        service: 'api',
        environment: 'production',
        status: 'success',
        duration_seconds: 184,
        tags: ['team:payments', 'region:us-east-1'],
        rollback: false,
        note: 'Deployed by the release train; see the internal runbook for rollback steps.',
        started_at: '2026-09-27T10:11:02Z',
        finished_at: '2026-09-27T10:14:06Z',
        deployment_id: 'dep_48213',
        deployment_url: 'https://deploys.example.com/api/dep_48213',
        deployment_updated_at: '2026-09-27T10:14:06Z',
      },
      deliveryId: '7f3a9c1e-2b44-4d0a-9d4f-8e1b2a6c5d01',
      dedupeKey: 'webhook.deploy.finished:webhook.deploy:dep_48213:2026-09-27T10:14:06Z',
    });
  });

  it('declares one open event type that accepts the flattened attributes', async () => {
    const [spec] = webhookSource.instanceEventTypes!(quickSettings);
    expect(spec?.type).toBe('webhook.deploy.finished');
    const [ev] = await make(quickSettings).parse!(delivery(finished));
    expect(validateAgainst(spec!.attributes, ev!.attributes).valid).toBe(true);
  });

  it('works with no settings at all: webhook.request.received, body.id, then a body hash', async () => {
    const src = make({ verification: 'none' });
    expect(webhookSource.instanceEventTypes!({ verification: 'none' }).map((t) => t.type)).toEqual([
      'webhook.request.received',
    ]);
    const withId = await src.parse!(rawRequest({ body: '{"id": 12, "action": "opened"}' }));
    expect(withId[0]).toMatchObject({
      type: 'webhook.request.received',
      artifact: { kind: 'webhook.request', id: '12' },
      attributes: { id: 12, action: 'opened' },
    });
    const a = await src.parse!(rawRequest({ body: '{"action": "opened"}' }));
    const b = await src.parse!(rawRequest({ body: '{"action": "opened"}' }));
    const c = await src.parse!(rawRequest({ body: '{"action": "closed"}' }));
    expect(a[0]!.artifact.id).toMatch(/^body-[0-9a-f]{16}$/);
    expect(a[0]!.dedupeKey).toBe(b[0]!.dedupeKey);
    expect(a[0]!.dedupeKey).not.toBe(c[0]!.dedupeKey);
  });

  it('explains a missing id path and a body without fields', async () => {
    const src = make({ verification: 'none', artifactIdPath: 'body.nope' });
    const report = await src.parseWithNotes!(rawRequest({ body: '"just text"' }));
    expect(report.events).toHaveLength(1);
    expect(report.events[0]!.attributes).toEqual({});
    expect(report.notes).toEqual([
      'body.nope is nothing, not an id, so the artifact id is a hash of the body.',
      'The body has no top-level text, number or boolean fields, so the event has no attributes.',
    ]);
  });

  it('derives the artifact kind from the event type', () => {
    expect(quickArtifactKind('webhook.deploy.finished')).toBe('webhook.deploy');
  });
});

describe('mapped mode', () => {
  it('picks the first rule whose condition holds and reads every fact by path', async () => {
    const events = await make(mappedSettings).parse!(delivery(issue));
    expect(events).toEqual([
      {
        type: 'webhook.issue.created',
        occurredAt: '2026-09-27T09:00:00.000Z',
        artifact: {
          kind: 'issue',
          id: 'ISS-42',
          url: 'https://tracker.example.com/issues/ISS-42',
          version: '2026-09-27T09:00:00Z',
        },
        attributes: { priority: 'high', estimate: 3, labels: ['bug', 'payments'], project: 'PAY' },
        deliveryId: 'b1c2d3e4-0000-4a1b-9c2d-111111111111',
        dedupeKey: 'webhook.issue.created:issue:ISS-42:2026-09-27T09:00:00Z',
      },
    ]);
    const updated = await make(mappedSettings).parse!(
      delivery(issue, { 'x-event-type': 'issue.updated' }),
    );
    expect(updated.map((e) => [e.type, e.attributes])).toEqual([
      ['webhook.issue.updated', { priority: 'high' }],
    ]);
  });

  it('declares one typed event type per rule type', () => {
    const specs = webhookSource.instanceEventTypes!(mappedSettings);
    expect(specs.map((s) => s.type)).toEqual(['webhook.issue.created', 'webhook.issue.updated']);
    expect(specs[0]!.attributes).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        priority: { type: 'string' },
        estimate: { type: 'number' },
        labels: { type: 'array', items: { type: 'string' } },
        project: { type: 'string', description: 'Project key' },
      },
    });
  });

  it('merges rules that produce the same type', () => {
    const rules: MappedRule[] = [
      {
        type: 'webhook.issue.changed',
        title: 'A',
        artifactKind: 'issue',
        artifactIdPath: 'body.id',
        attributes: [{ name: 'a', path: 'body.a', type: 'string' }],
      },
      {
        type: 'webhook.issue.changed',
        title: 'B',
        artifactKind: 'issue',
        artifactIdPath: 'body.id',
        attributes: [
          { name: 'a', path: 'body.a', type: 'number' },
          { name: 'b', path: 'body.b', type: 'boolean' },
        ],
      },
    ];
    expect(ruleDefinitions(rules)).toEqual([
      {
        type: 'webhook.issue.changed',
        title: 'A',
        attributes: [
          { name: 'a', type: 'string' },
          { name: 'b', type: 'boolean' },
        ],
      },
    ]);
  });

  it('a condition without a value matches any value, and none matches everything', async () => {
    const rule = (when?: MappedRule['when']): Settings => ({
      verification: 'none',
      mappingMode: 'mapped',
      rules: [
        {
          type: 'webhook.thing.seen',
          title: 'Seen',
          artifactKind: 't',
          artifactIdPath: 'body.id',
          when,
        },
      ],
    });
    const req = rawRequest({ body: '{"id": 1, "flag": "x"}' });
    expect(await make(rule({ path: 'body.flag' })).parse!(req)).toHaveLength(1);
    expect(await make(rule({ path: 'body.other' })).parse!(req)).toHaveLength(0);
    expect(await make(rule({})).parse!(req)).toHaveLength(1);
    expect(await make(rule()).parse!(req)).toHaveLength(1);
  });

  it('explains why a delivery produced nothing or lost an attribute', async () => {
    const src = make(mappedSettings);
    const none = await src.parseWithNotes!(delivery(issue, { 'x-event-type': 'issue.deleted' }));
    expect(none.events).toEqual([]);
    expect(none.notes).toEqual([
      'No rule matched, so this delivery produces no event. Rule 1 (Issue created) wants headers.x-event-type = "issue.created" and it is "issue.deleted"; Rule 2 (Issue updated) wants headers.x-event-type = "issue.updated" and it is "issue.deleted".',
    ]);

    const noId = await src.parseWithNotes!(delivery({ headers: issue.headers, body: {} }));
    expect(noId.events).toEqual([]);
    expect(noId.notes).toEqual([
      'Rule 1 (Issue created) matched, but its artifact id path body.issue.id is nothing, so no event was produced.',
    ]);

    const odd = structuredClone(issue);
    (odd.body.issue as Record<string, unknown>).estimate = 'soon';
    delete (odd.body.issue as Record<string, unknown>).priority;
    const partial = await src.parseWithNotes!(delivery(odd));
    expect(partial.events[0]!.attributes).toEqual({ labels: ['bug', 'payments'], project: 'PAY' });
    expect(partial.notes).toEqual([
      'Rule 1 (Issue created): attribute priority — body.issue.priority has no value.',
      'Rule 1 (Issue created): attribute estimate — "soon" is not a number.',
    ]);
  });

  it('falls back to a body hash for the dedupe key without a version or delivery id', async () => {
    const s: Settings = {
      verification: 'none',
      mappingMode: 'mapped',
      rules: [
        { type: 'webhook.thing.seen', title: 'Seen', artifactKind: 't', artifactIdPath: 'body.id' },
      ],
    };
    const [a] = await make(s).parse!(rawRequest({ body: '{"id": 1, "n": 1}' }));
    const [b] = await make(s).parse!(rawRequest({ body: '{"id": 1, "n": 2}' }));
    expect(a!.dedupeKey).toMatch(/^webhook\.thing\.seen:t:1:body-[0-9a-f]{16}$/);
    expect(a!.dedupeKey).not.toBe(b!.dedupeKey);
    expect(a).not.toHaveProperty('deliveryId');
  });
});

describe('jsonata mode notes', () => {
  it('explains dropped results', async () => {
    const src = make({
      ...legacySettings,
      mappingMode: 'jsonata',
      mapping:
        "[{ 'type': 'webhook.nope.never', 'artifact': { 'kind': 'k', 'id': '1' } }, { 'type': 'webhook.deploy.started', 'artifact': { 'kind': 'k' } }, 'text']",
    });
    const report = await src.parseWithNotes!(delivery(finished));
    expect(report.events).toEqual([]);
    expect(report.notes).toEqual([
      'Mapping result 1 has type webhook.nope.never, which is not one of the event types (webhook.deploy.finished, webhook.deploy.started), so it was dropped.',
      'Mapping result 2 (webhook.deploy.started) needs an artifact with a "kind" and an "id", so it was dropped.',
      'Mapping result 3 is not an object, so it was dropped.',
    ]);
    const empty = await make({ ...legacySettings, mapping: 'body.missing' }).parseWithNotes!(
      delivery(finished),
    );
    expect(empty.notes).toEqual(['The mapping returned nothing for this delivery.']);
  });
});
