import { describe, expect, it } from 'vitest';

import { signHmac, validatePlugin, type RawRequest, type Settings } from '@ai-switchboard/sdk';
import {
  createStubHttp,
  createTestContext,
  rawRequest,
  runConformance,
  sourceConformanceChecks,
  type StubHandler,
  type StubReply,
  type StubRequest,
} from '@ai-switchboard/sdk/testing';

import apiIssue from './__fixtures__/api-issue.json' with { type: 'json' };
import commentCreated from './__fixtures__/comment-created.json' with { type: 'json' };
import issueCreated from './__fixtures__/issue-created.json' with { type: 'json' };
import labelsChanged from './__fixtures__/issue-labels-changed.json' with { type: 'json' };
import priorityChanged from './__fixtures__/issue-priority-changed.json' with { type: 'json' };
import stateChanged from './__fixtures__/issue-state-changed.json' with { type: 'json' };
import plugin from './plugin.js';
import { linearSource } from './source.js';

const SECRET = 'fixture-secret';
const API_KEY = 'lin_api_fixtureKey000000000000000000000000';
const NOW = new Date('2026-09-27T10:35:00.000Z');

interface Delivery {
  delivery: string;
  body: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Patchable = Record<string, any>;

/** Sign a fixture; `webhookTimestamp` is set 1.5 s before `NOW` unless the patch sets it. */
function deliver(
  fixture: Delivery,
  patch?: (body: Patchable) => void,
  headers: Record<string, string | undefined> = {},
): RawRequest {
  const body: Patchable = {
    ...structuredClone(fixture.body),
    webhookTimestamp: NOW.getTime() - 1500,
  };
  patch?.(body);
  const text = JSON.stringify(body);
  return rawRequest({
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'Linear-Webhook',
      'linear-delivery': fixture.delivery,
      'linear-event': String(body.type),
      'linear-signature': signHmac({ secret: SECRET, payload: text }),
      ...headers,
    },
    body: text,
    receivedAt: NOW.toISOString(),
  });
}

const baseSettings: Settings = { apiKey: API_KEY, webhookSecret: SECRET };

type Gql = (variables: Record<string, unknown>, req: StubRequest) => StubReply | undefined;

/** A GraphQL stub dispatching on the operation name. */
function linearApi(ops: Record<string, Gql> = {}): StubHandler {
  return (req) => {
    if (req.url.href !== 'https://api.linear.app/graphql' || req.method !== 'POST')
      return undefined;
    const { query, variables } = req.json<{ query: string; variables: Record<string, unknown> }>();
    const op =
      /^(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? (query.includes('viewer') ? 'Viewer' : '');
    const handler = ops[op];
    if (handler) return handler(variables, req);
    if (op === 'Issue') {
      return variables.id === 'LOL-1712'
        ? { json: apiIssue }
        : {
            json: {
              errors: [
                {
                  message: 'Entity not found: Issue',
                  extensions: {
                    type: 'invalid input',
                    code: 'INPUT_ERROR',
                    userPresentableMessage: 'Could not find referenced Issue.',
                  },
                },
              ],
              data: null,
            },
          };
    }
    if (op === 'Viewer') return { json: { data: { viewer: { id: 'u1', name: 'Ilya Volodin' } } } };
    return { status: 400, json: { errors: [{ message: `unexpected operation ${op}` }] } };
  };
}

function make(s: Settings = baseSettings, handler: StubHandler = linearApi(), now = () => NOW) {
  const stub = createStubHttp(handler, plugin.capabilities.network);
  const source = linearSource.create(s, createTestContext({ http: stub.client, now }));
  return { source, calls: stub.calls };
}

const parse = (req: RawRequest, s: Settings = baseSettings) => make(s).source.parse!(req);

runConformance(
  'linear source',
  sourceConformanceChecks(linearSource, {
    settings: baseSettings,
    secrets: [SECRET, API_KEY],
    http: linearApi(),
    now: () => NOW,
    push: {
      deliveries: [issueCreated, labelsChanged, stateChanged, priorityChanged, commentCreated].map(
        (d) => deliver(d),
      ),
      sameChange: [
        deliver(stateChanged),
        deliver(stateChanged, undefined, { 'linear-delivery': 'redelivered-6e7f8a9b' }),
      ],
      differentChange: [
        deliver(stateChanged),
        deliver(stateChanged, (b) => {
          b.data.updatedAt = '2026-09-27T10:22:00.000Z';
          b.updatedFrom.stateId = b.data.stateId;
        }),
      ],
      wrongSignature: deliver(issueCreated, undefined, { 'linear-signature': 'ab'.repeat(32) }),
      missingHeader: deliver(issueCreated, undefined, { 'linear-signature': undefined }),
      staleTimestamp: deliver(issueCreated, (b) => (b.webhookTimestamp = NOW.getTime() - 61_000)),
    },
    resolveNotFound: { kind: 'linear.issue', id: 'LOL-9999' },
  }),
  { describe, it },
);

describe('linear manifest', () => {
  it('validates and calls only api.linear.app', () => {
    expect(validatePlugin(plugin)).toEqual([]);
    expect(plugin.capabilities.network).toEqual(['api.linear.app']);
    expect(linearSource.eventTypes.map((e) => e.type)).toEqual([
      'linear.issue.created',
      'linear.issue.labeled',
      'linear.issue.unlabeled',
      'linear.issue.state_changed',
      'linear.issue.updated',
      'linear.comment.created',
    ]);
  });
});

describe('linear verify', () => {
  it('accepts a fresh, correctly signed delivery', () => {
    expect(make().source.verify!(deliver(issueCreated))).toEqual({ ok: true });
  });

  it('rejects timestamps more than 60 s away in either direction, and a missing one', () => {
    const { source } = make();
    expect(
      source.verify!(deliver(issueCreated, (b) => (b.webhookTimestamp = NOW.getTime() - 60_000)))
        .ok,
    ).toBe(true);
    expect(
      source.verify!(deliver(issueCreated, (b) => (b.webhookTimestamp = NOW.getTime() - 60_001))),
    ).toEqual({
      ok: false,
      reason: 'webhookTimestamp is more than 60 s from now',
    });
    expect(
      source.verify!(deliver(issueCreated, (b) => (b.webhookTimestamp = NOW.getTime() + 90_000)))
        .ok,
    ).toBe(false);
    expect(source.verify!(deliver(issueCreated, (b) => delete b.webhookTimestamp))).toEqual({
      ok: false,
      reason: 'missing webhookTimestamp',
    });
    expect(
      source.verify!(deliver(issueCreated, (b) => (b.webhookTimestamp = String(NOW.getTime())))),
    ).toMatchObject({ ok: false });
  });

  it('checks the signature before trusting the timestamp', () => {
    const req = deliver(issueCreated);
    const forged = Buffer.from(req.body.toString().replace('"LOL-1712"', '"LOL-1713"'));
    expect(make().source.verify!({ ...req, body: forged })).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
    expect(make().source.verify!({ ...req, body: Buffer.from('not json') }).ok).toBe(false);
  });

  it('uses the context clock', () => {
    const later = make(baseSettings, linearApi(), () => new Date(NOW.getTime() + 120_000));
    expect(later.source.verify!(deliver(issueCreated)).ok).toBe(false);
  });
});

describe('linear parse', () => {
  it('maps an issue create', async () => {
    expect(await parse(deliver(issueCreated))).toEqual([
      {
        type: 'linear.issue.created',
        occurredAt: '2026-09-27T09:40:12.331Z',
        artifact: {
          kind: 'linear.issue',
          id: 'LOL-1712',
          url: 'https://linear.app/lola/issue/LOL-1712/retry-webhook-deliveries-with-backoff',
          version: '2026-09-27T09:40:12.331Z',
        },
        attributes: {
          team: 'LOL',
          identifier: 'LOL-1712',
          title: 'Retry webhook deliveries with backoff',
          state: 'Todo',
          stateType: 'unstarted',
          priority: 2,
          priorityLabel: 'High',
          labels: ['backend'],
          assignee: 'Ilya Volodin',
          actor: 'Ilya Volodin',
        },
        deliveryId: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d',
        dedupeKey: 'linear.issue.created:linear.issue:LOL-1712:2026-09-27T09:40:12.331Z',
      },
    ]);
  });

  it('emits one event per label added or removed, with names where Linear gives them', async () => {
    const events = await parse(deliver(labelsChanged));
    expect(
      events.map((e) => [e.type, e.attributes.label, e.attributes.labelId, e.artifact.version]),
    ).toEqual([
      [
        'linear.issue.labeled',
        'agent-ready',
        '3f0b8a52-8a7e-4d3c-9d7e-1f2a3b4c5d6e',
        '2026-09-27T10:14:58.902Z:3f0b8a52-8a7e-4d3c-9d7e-1f2a3b4c5d6e',
      ],
      [
        'linear.issue.unlabeled',
        '77e6d5c4-b3a2-4910-8f7e-6d5c4b3a2910',
        '77e6d5c4-b3a2-4910-8f7e-6d5c4b3a2910',
        '2026-09-27T10:14:58.902Z:77e6d5c4-b3a2-4910-8f7e-6d5c4b3a2910',
      ],
    ]);
    expect(events[0]!.attributes.labels).toEqual(['backend', 'agent-ready']);
    expect(new Set(events.map((e) => e.dedupeKey)).size).toBe(2);
  });

  it('emits no label events when the label set did not really change', async () => {
    const events = await parse(
      deliver(labelsChanged, (b) => {
        b.updatedFrom.labelIds = [...b.data.labelIds].reverse();
      }),
    );
    expect(events).toEqual([]);
  });

  it('maps a state change without a separate updated event', async () => {
    const events = await parse(deliver(stateChanged));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'linear.issue.state_changed',
      occurredAt: '2026-09-27T10:20:41.777Z',
      artifact: { id: 'LOL-1712', version: '2026-09-27T10:20:41.777Z' },
      attributes: {
        fromStateId: '6a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b',
        toState: 'In Progress',
        toStateId: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
        state: 'In Progress',
      },
    });
    expect(events[0]!.attributes.fromState).toBeUndefined();
  });

  it('includes fromState when the payload names it', async () => {
    const [ev] = await parse(
      deliver(stateChanged, (b) => (b.updatedFrom.state = { name: 'Todo' })),
    );
    expect(ev!.attributes.fromState).toBe('Todo');
  });

  it('maps other changes to updated with the changed fields, ignoring bookkeeping', async () => {
    const events = await parse(deliver(priorityChanged));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'linear.issue.updated',
      attributes: { changedFields: ['priority'], priority: 1, priorityLabel: 'Urgent' },
    });
  });

  it('emits labeled, state_changed and updated together when one update does all three', async () => {
    const events = await parse(
      deliver(labelsChanged, (b) => {
        b.updatedFrom.stateId = '6a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
        b.updatedFrom.assigneeId = null;
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      'linear.issue.labeled',
      'linear.issue.unlabeled',
      'linear.issue.state_changed',
      'linear.issue.updated',
    ]);
    expect(events[3]!.attributes.changedFields).toEqual(['assigneeId']);
  });

  it('treats an update that only touched updatedAt as updated with no fields', async () => {
    const [ev] = await parse(
      deliver(priorityChanged, (b) => (b.updatedFrom = { updatedAt: '2026-09-27T10:20:41.777Z' })),
    );
    expect(ev).toMatchObject({ type: 'linear.issue.updated', attributes: { changedFields: [] } });
  });

  it('maps a comment create onto its issue without the comment text', async () => {
    const [ev] = await parse(deliver(commentCreated));
    expect(ev).toEqual({
      type: 'linear.comment.created',
      occurredAt: '2026-09-27T10:33:40.118Z',
      artifact: {
        kind: 'linear.issue',
        id: 'LOL-1712',
        url: 'https://linear.app/lola/issue/LOL-1712/retry-webhook-deliveries-with-backoff',
        version: 'comment:9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
      },
      attributes: {
        identifier: 'LOL-1712',
        team: 'LOL',
        title: 'Retry webhook deliveries with backoff',
        actor: 'Ilya Volodin',
        commentId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
      },
      deliveryId: '0c1d2e3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f',
      dedupeKey:
        'linear.comment.created:linear.issue:LOL-1712:comment:9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
    });
    expect(JSON.stringify(ev)).not.toContain('Agent picked this up');
  });

  it('never copies the issue description into attributes', async () => {
    for (const d of [issueCreated, labelsChanged, stateChanged, priorityChanged]) {
      for (const ev of await parse(deliver(d)))
        expect(JSON.stringify(ev.attributes)).not.toContain('incident notes');
    }
  });

  it('ignores removes, other resource types and non-JSON bodies', async () => {
    expect(await parse(deliver(issueCreated, (b) => (b.action = 'remove')))).toEqual([]);
    expect(await parse(deliver(commentCreated, (b) => (b.action = 'update')))).toEqual([]);
    expect(await parse(deliver(issueCreated, (b) => (b.type = 'Project')))).toEqual([]);
    expect(await parse(rawRequest({ body: 'nope' }))).toEqual([]);
  });

  it('filters by team key, using the identifier prefix when the team is absent', async () => {
    const lol = { ...baseSettings, teamKeys: ['lol'] };
    const eng = { ...baseSettings, teamKeys: ['ENG'] };
    expect(await parse(deliver(issueCreated), lol)).toHaveLength(1);
    expect(await parse(deliver(issueCreated), eng)).toEqual([]);
    expect(await parse(deliver(commentCreated), eng)).toEqual([]);
    const noTeam = deliver(issueCreated, (b) => delete b.data.team);
    expect(await parse(noTeam, lol)).toHaveLength(1);
    expect((await parse(noTeam))[0]!.attributes.team).toBe('LOL');
  });

  it('falls back to the delivery id only when there is no updatedAt', async () => {
    const [ev] = await parse(deliver(priorityChanged, (b) => delete b.data.updatedAt));
    expect(ev!.dedupeKey).toBe(
      'linear.issue.updated:linear.issue:LOL-1712:8a9b0c1d-2e3f-4a4b-8c5d-6e7f8a9b0c1d',
    );
    expect(ev!.occurredAt).toBe('2026-09-27T10:14:59.120Z');
  });
});

describe('linear resolve', () => {
  it('returns live issue state', async () => {
    const { source, calls } = make();
    expect(await source.resolve!({ kind: 'linear.issue', id: 'LOL-1712' })).toEqual({
      ref: {
        kind: 'linear.issue',
        id: 'LOL-1712',
        url: 'https://linear.app/lola/issue/LOL-1712/retry-webhook-deliveries-with-backoff',
        version: '2026-09-27T10:31:09.010Z',
      },
      title: 'Retry webhook deliveries with backoff',
      state: 'In Progress',
      stateType: 'started',
      labels: ['backend', 'agent-ready'],
      priority: 1,
      assignee: 'Ilya Volodin',
      url: 'https://linear.app/lola/issue/LOL-1712/retry-webhook-deliveries-with-backoff',
      updatedAt: '2026-09-27T10:31:09.010Z',
    });
    expect(calls[0]!.headers.authorization).toBe(API_KEY);
  });

  it('returns null for a missing issue and throws on other errors', async () => {
    expect(await make().source.resolve!({ kind: 'linear.issue', id: 'LOL-9999' })).toBeNull();
    const nullIssue = make(
      baseSettings,
      linearApi({ Issue: () => ({ json: { data: { issue: null } } }) }),
    );
    expect(await nullIssue.source.resolve!({ kind: 'linear.issue', id: 'LOL-1' })).toBeNull();
    const broken = make(baseSettings, () => ({
      status: 401,
      json: { errors: [{ message: 'Authentication required, not authenticated' }] },
    }));
    await expect(broken.source.resolve!({ kind: 'linear.issue', id: 'LOL-1712' })).rejects.toThrow(
      /Authentication required/,
    );
    await expect(make().source.resolve!({ kind: 'github.pr', id: 'acme/api#1' })).rejects.toThrow(
      /cannot look up/,
    );
  });
});

describe('linear act', () => {
  const artifact = { kind: 'linear.issue', id: 'LOL-1712' };

  it('addLabel resolves the label by name, preferring the team label, and keeps existing labels', async () => {
    let update: Record<string, unknown> | undefined;
    const { source } = make(
      baseSettings,
      linearApi({
        Labels: (v) => {
          expect(v).toEqual({ name: 'Needs QA' });
          return {
            json: {
              data: {
                issueLabels: {
                  nodes: [
                    { id: 'lbl-other-team', name: 'needs qa', team: { id: 'other' } },
                    { id: 'lbl-workspace', name: 'Needs QA', team: null },
                    {
                      id: 'lbl-team',
                      name: 'Needs QA',
                      team: { id: '8c2f1d0e-3b4a-4c5d-9e6f-7a8b9c0d1e2f' },
                    },
                  ],
                },
              },
            },
          };
        },
        IssueUpdate: (v) => {
          update = v;
          return { json: { data: { issueUpdate: { success: true } } } };
        },
      }),
    );
    expect(await source.act!('addLabel', { artifact, label: 'Needs QA' })).toEqual({
      ok: true,
      message: 'Added label Needs QA to LOL-1712',
    });
    expect(update).toEqual({
      id: 'f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b',
      input: {
        labelIds: [
          'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
          '3f0b8a52-8a7e-4d3c-9d7e-1f2a3b4c5d6e',
          'lbl-team',
        ],
      },
    });
  });

  it('addLabel is a no-op when the issue already has the label, and fails for an unknown label', async () => {
    const { source, calls } = make(
      baseSettings,
      linearApi({ Labels: () => ({ json: { data: { issueLabels: { nodes: [] } } } }) }),
    );
    expect(await source.act!('addLabel', { artifact, label: 'AGENT-READY' })).toMatchObject({
      ok: true,
      message: expect.stringContaining('already') as string,
    });
    expect(calls).toHaveLength(1);
    expect(await source.act!('addLabel', { artifact, label: 'nope' })).toMatchObject({ ok: false });
  });

  it('setState finds the state in the issue team and updates it', async () => {
    let update: Record<string, unknown> | undefined;
    const { source } = make(
      baseSettings,
      linearApi({
        States: (v) => {
          expect(v).toEqual({ teamId: '8c2f1d0e-3b4a-4c5d-9e6f-7a8b9c0d1e2f', name: 'in review' });
          return {
            json: { data: { workflowStates: { nodes: [{ id: 'st-review', name: 'In Review' }] } } },
          };
        },
        IssueUpdate: (v) => {
          update = v;
          return { json: { data: { issueUpdate: { success: true } } } };
        },
      }),
    );
    expect(await source.act!('setState', { artifact, state: 'in review' })).toEqual({
      ok: true,
      message: 'Moved LOL-1712 to In Review',
    });
    expect(update).toMatchObject({ input: { stateId: 'st-review' } });
  });

  it('setState reports an unknown state and skips a no-op move', async () => {
    const unknown = make(
      baseSettings,
      linearApi({ States: () => ({ json: { data: { workflowStates: { nodes: [] } } } }) }),
    );
    expect((await unknown.source.act!('setState', { artifact, state: 'Shipped' })).ok).toBe(false);
    const same = make(
      baseSettings,
      linearApi({
        States: () => ({
          json: {
            data: {
              workflowStates: {
                nodes: [{ id: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e', name: 'In Progress' }],
              },
            },
          },
        }),
      }),
    );
    expect(await same.source.act!('setState', { artifact, state: 'In Progress' })).toMatchObject({
      ok: true,
      message: expect.stringContaining('already') as string,
    });
    expect(same.calls.some((c) => c.body.includes('IssueUpdate'))).toBe(false);
  });

  it('comment creates a comment on the issue id', async () => {
    const { source } = make(
      baseSettings,
      linearApi({
        CommentCreate: (v) => {
          expect(v).toEqual({
            input: { issueId: 'f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b', body: 'Run started.' },
          });
          return {
            json: {
              data: {
                commentCreate: {
                  success: true,
                  comment: { id: 'c-1', url: 'https://linear.app/lola/issue/LOL-1712#comment-c1' },
                },
              },
            },
          };
        },
      }),
    );
    expect(await source.act!('comment', { artifact, body: 'Run started.' })).toEqual({
      ok: true,
      message: 'Commented on LOL-1712',
      data: { id: 'c-1', url: 'https://linear.app/lola/issue/LOL-1712#comment-c1' },
    });
  });

  it('refuses invalid args, unknown actions and missing issues, and reports GraphQL errors', async () => {
    const { source } = make(
      baseSettings,
      linearApi({ CommentCreate: () => ({ json: { errors: [{ message: 'Forbidden' }] } }) }),
    );
    expect((await source.act!('comment', { artifact })).ok).toBe(false);
    expect(
      (await source.act!('comment', { artifact: { kind: 'github.pr', id: 'x' }, body: 'x' })).ok,
    ).toBe(false);
    expect(await source.act!('archive', { artifact })).toEqual({
      ok: false,
      message: 'Unknown action "archive"',
    });
    expect(
      await source.act!('comment', { artifact: { ...artifact, id: 'LOL-9999' }, body: 'x' }),
    ).toEqual({ ok: false, message: 'LOL-9999 was not found' });
    expect(await source.act!('comment', { artifact, body: 'x' })).toEqual({
      ok: false,
      message: 'Linear answered 200: Forbidden',
    });
  });
});

describe('linear provision', () => {
  it('creates one webhook for all public teams with the signing secret', async () => {
    let input: unknown;
    const { source } = make(
      baseSettings,
      linearApi({
        WebhookCreate: (v) => {
          input = v.input;
          return {
            json: {
              data: { webhookCreate: { success: true, webhook: { id: 'wh-1', enabled: true } } },
            },
          };
        },
      }),
    );
    expect(await source.provision!('https://switchboard.example.com/hooks/src_lin')).toEqual({
      ok: true,
      externalId: 'wh-1',
      message: 'Created 1 Linear webhook(s)',
    });
    expect(input).toEqual({
      url: 'https://switchboard.example.com/hooks/src_lin',
      resourceTypes: ['Issue', 'Comment'],
      secret: SECRET,
      label: 'AI Switchboard',
      allPublicTeams: true,
    });
  });

  it('creates one webhook per configured team and reports unknown team keys', async () => {
    const created: unknown[] = [];
    const handler = linearApi({
      Teams: () => ({
        json: {
          data: {
            teams: {
              nodes: [
                { id: 't-lol', key: 'LOL' },
                { id: 't-eng', key: 'ENG' },
              ],
            },
          },
        },
      }),
      WebhookCreate: (v) => {
        created.push((v.input as { teamId: string }).teamId);
        return {
          json: {
            data: { webhookCreate: { success: true, webhook: { id: `wh-${created.length}` } } },
          },
        };
      },
    });
    const two = make({ ...baseSettings, teamKeys: ['LOL', 'eng'] }, handler);
    expect(await two.source.provision!('https://switchboard.example.com/hooks/x')).toMatchObject({
      ok: true,
      externalId: 'wh-1,wh-2',
    });
    expect(created).toEqual(['t-lol', 't-eng']);
    const missing = make({ ...baseSettings, teamKeys: ['LOL', 'OPS'] }, handler);
    expect(await missing.source.provision!('https://switchboard.example.com/hooks/x')).toEqual({
      ok: false,
      message: 'Unknown team keys: OPS',
    });
  });

  it('reports a refusal', async () => {
    const { source } = make(
      baseSettings,
      linearApi({ WebhookCreate: () => ({ json: { errors: [{ message: 'Admin required' }] } }) }),
    );
    expect(await source.provision!('https://x.test/hooks/1')).toEqual({
      ok: false,
      message: 'Linear answered 200: Admin required',
    });
  });
});

describe('linear health', () => {
  it('is healthy when the API key authenticates, unhealthy otherwise', async () => {
    expect(await make().source.health()).toEqual({
      status: 'healthy',
      message: 'Authenticated as Ilya Volodin',
      checkedAt: NOW.toISOString(),
    });
    const bad = make(baseSettings, () => ({
      status: 400,
      json: { errors: [{ message: 'Authentication required, not authenticated' }] },
    }));
    expect(await bad.source.health()).toMatchObject({
      status: 'unhealthy',
      message: expect.stringContaining('Authentication required') as string,
    });
  });
});
