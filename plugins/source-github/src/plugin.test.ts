import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signHmac, validatePlugin, type RawRequest, type Settings } from '@ai-switchboard/sdk';
import {
  createMemoryState,
  createStubHttp,
  createTestContext,
  rawRequest,
  runConformance,
  sourceConformanceChecks,
  type StubHandler,
} from '@ai-switchboard/sdk/testing';

import apiResponses from './__fixtures__/api-responses.json' with { type: 'json' };
import checkSuiteCompleted from './__fixtures__/check-suite-completed.json' with { type: 'json' };
import issueLabeled from './__fixtures__/issue-labeled.json' with { type: 'json' };
import ping from './__fixtures__/ping.json' with { type: 'json' };
import prLabeled from './__fixtures__/pr-labeled.json' with { type: 'json' };
import prMerged from './__fixtures__/pr-merged.json' with { type: 'json' };
import prOpened from './__fixtures__/pr-opened.json' with { type: 'json' };
import prReview from './__fixtures__/pr-review-submitted.json' with { type: 'json' };
import push from './__fixtures__/push.json' with { type: 'json' };
import releasePublished from './__fixtures__/release-published.json' with { type: 'json' };
import { extractLinks } from './links.js';
import plugin from './plugin.js';
import { githubSource } from './source.js';

const SECRET = 'fixture-secret';
const TOKEN = 'fixture-token';
const NOW = new Date('2026-09-27T12:00:00.000Z');

interface Delivery {
  event: string;
  delivery: string;
  body: unknown;
}

// Fixture patches reach deep into GitHub payloads; typing every shape would add nothing here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Patchable = Record<string, any>;

function deliver(
  fixture: Delivery,
  patch?: (body: Patchable) => void,
  headers: Record<string, string | undefined> = {},
): RawRequest {
  const body = structuredClone(fixture.body) as Patchable;
  patch?.(body);
  const text = JSON.stringify(body);
  return rawRequest({
    headers: {
      'content-type': 'application/json',
      'user-agent': 'GitHub-Hookshot/7a1b2c3',
      'x-github-event': fixture.event,
      'x-github-delivery': fixture.delivery,
      'x-github-hook-id': '501234987',
      'x-hub-signature-256': `sha256=${signHmac({ secret: SECRET, payload: text })}`,
      ...headers,
    },
    body: text,
    receivedAt: '2026-09-27T12:00:01.000Z',
  });
}

const tokenSettings: Settings = {
  authMode: 'token',
  token: TOKEN,
  owner: 'acme',
  webhookSecret: SECRET,
};

/** A small GitHub REST stub: the PR and issue from the fixtures, a rate limit, and 404s. */
function githubApi(extra?: StubHandler): StubHandler {
  return async (req) => {
    const fromExtra = await extra?.(req);
    if (fromExtra) return fromExtra;
    const p = req.url.pathname;
    if (p === '/rate_limit')
      return { json: { rate: { limit: 5000, remaining: 4987, reset: 1790512800 } } };
    if (req.method === 'GET' && p === '/repos/acme/api/pulls/482')
      return { json: apiResponses.pull };
    if (req.method === 'GET' && p === '/repos/acme/api/issues/12')
      return { json: apiResponses.issue };
    return undefined;
  };
}

function make(s: Settings = tokenSettings, handler: StubHandler = githubApi(), now = () => NOW) {
  const stub = createStubHttp(handler, plugin.capabilities.network);
  const state = createMemoryState();
  const source = githubSource.create(s, createTestContext({ http: stub.client, now, state }));
  return { source, calls: stub.calls, state };
}

async function parse(req: RawRequest, s: Settings = tokenSettings) {
  return make(s).source.parse!(req);
}

const allDeliveries = [
  prOpened,
  prLabeled,
  prMerged,
  prReview,
  issueLabeled,
  checkSuiteCompleted,
  releasePublished,
  push,
  ping,
];

runConformance(
  'github source',
  sourceConformanceChecks(githubSource, {
    settings: tokenSettings,
    secrets: [SECRET, TOKEN],
    http: githubApi(),
    now: () => NOW,
    push: {
      deliveries: allDeliveries.map((d) => deliver(d)),
      sameChange: [
        deliver(prLabeled),
        deliver(prLabeled, undefined, { 'x-github-delivery': 'redelivery-of-5d1f0a20' }),
      ],
      // Same PR, same second, a different label: must not collapse.
      differentChange: [
        deliver(prLabeled),
        deliver(prLabeled, (b) => {
          b.label = { ...b.label, name: 'backend-urgent' };
        }),
      ],
      wrongSignature: deliver(prOpened, undefined, {
        'x-hub-signature-256': `sha256=${'ab'.repeat(32)}`,
      }),
      missingHeader: deliver(prOpened, undefined, { 'x-hub-signature-256': undefined }),
    },
    resolveNotFound: { kind: 'github.pr', id: 'acme/api#404' },
  }),
  { describe, it },
);

describe('github manifest', () => {
  it('validates and calls only api.github.com', () => {
    expect(validatePlugin(plugin)).toEqual([]);
    expect(plugin.capabilities.network).toEqual(['api.github.com']);
    expect(githubSource.eventTypes.map((e) => e.type)).toEqual([
      'github.pr.opened',
      'github.pr.closed',
      'github.pr.merged',
      'github.pr.reopened',
      'github.pr.labeled',
      'github.pr.unlabeled',
      'github.pr.ready_for_review',
      'github.pr.synchronize',
      'github.pr.review_submitted',
      'github.issue.opened',
      'github.issue.closed',
      'github.issue.reopened',
      'github.issue.labeled',
      'github.issue.unlabeled',
      'github.check_suite.completed',
      'github.release.published',
      'github.push',
    ]);
  });

  it('requires App credentials in app mode and a token in token mode', () => {
    expect(() => make({ ...tokenSettings, token: undefined })).toThrow(/Invalid github settings/);
    expect(() =>
      make({ authMode: 'app', owner: 'acme', webhookSecret: SECRET, appId: '1' }),
    ).toThrow(/privateKey|installationId/);
    expect(() => make({ ...tokenSettings, webhookSecret: '' })).toThrow(/Invalid github settings/);
  });
});

describe('github verify', () => {
  it('accepts a valid X-Hub-Signature-256 and rejects tampering or the wrong prefix', () => {
    const { source } = make();
    const good = deliver(prOpened);
    expect(source.verify!(good)).toEqual({ ok: true });
    expect(source.verify!({ ...good, body: Buffer.concat([good.body, Buffer.from(' ')]) })).toEqual(
      {
        ok: false,
        reason: 'signature mismatch',
      },
    );
    const sha1 = `sha1=${signHmac({ secret: SECRET, payload: good.body, algorithm: 'sha1' })}`;
    expect(
      source.verify!({ ...good, headers: { ...good.headers, 'x-hub-signature-256': sha1 } }).ok,
    ).toBe(false);
    expect(
      source.verify!(deliver(prOpened, undefined, { 'x-hub-signature-256': 'sha256=' })).ok,
    ).toBe(false);
    expect(
      source.verify!(deliver(prOpened, undefined, { 'x-hub-signature-256': 'sha256=zz' })).ok,
    ).toBe(false);
  });

  it('names the missing header', () => {
    const { source } = make();
    expect(
      source.verify!(deliver(prOpened, undefined, { 'x-hub-signature-256': undefined })),
    ).toEqual({
      ok: false,
      reason: 'missing x-hub-signature-256 header',
    });
  });
});

describe('github parse: pull requests', () => {
  it('maps pull_request.opened', async () => {
    expect(await parse(deliver(prOpened))).toEqual([
      {
        type: 'github.pr.opened',
        occurredAt: '2026-09-27T10:02:13.000Z',
        artifact: {
          kind: 'github.pr',
          id: 'acme/api#482',
          url: 'https://github.com/acme/api/pull/482',
          version: '2026-09-27T10:02:13Z',
        },
        attributes: {
          repo: 'acme/api',
          number: 482,
          title: 'Retry webhook deliveries with backoff',
          author: 'octocat',
          state: 'open',
          draft: false,
          merged: false,
          baseRef: 'main',
          headRef: 'feat/retry-backoff',
          labels: ['backend'],
          action: 'opened',
          sender: 'octocat',
        },
        deliveryId: '3b7e1c80-7c7a-11ef-8f4a-2f0d0a3e1b11',
        dedupeKey: 'github.pr.opened:github.pr:acme/api#482:2026-09-27T10:02:13Z',
      },
    ]);
  });

  it('never copies the pull request body into attributes', async () => {
    const [ev] = await parse(deliver(prOpened));
    const values = Object.values(ev!.attributes).flat().map(String);
    expect(values.some((v) => v.includes('exponential backoff'))).toBe(false);
  });

  it('maps labeled with the label and a label-specific version', async () => {
    const [ev] = await parse(deliver(prLabeled));
    expect(ev!.type).toBe('github.pr.labeled');
    expect(ev!.attributes.label).toBe('needs-review');
    expect(ev!.attributes.labels).toEqual(['backend', 'needs-review']);
    expect(ev!.attributes.sender).toBe('monalisa');
    expect(ev!.artifact.version).toBe('2026-09-27T10:05:31Z:needs-review');
  });

  it('maps unlabeled, reopened and ready_for_review', async () => {
    const unlabeled = await parse(
      deliver(prLabeled, (b) => {
        b.action = 'unlabeled';
        b.pull_request.labels = [];
      }),
    );
    expect(unlabeled[0]!.type).toBe('github.pr.unlabeled');
    expect(unlabeled[0]!.attributes.labels).toEqual([]);
    const reopened = await parse(deliver(prOpened, (b) => (b.action = 'reopened')));
    expect(reopened[0]!.type).toBe('github.pr.reopened');
    const ready = await parse(deliver(prOpened, (b) => (b.action = 'ready_for_review')));
    expect(ready[0]!.type).toBe('github.pr.ready_for_review');
  });

  it('maps closed with merged=true to github.pr.merged, at the merge time', async () => {
    const [ev] = await parse(deliver(prMerged));
    expect(ev!.type).toBe('github.pr.merged');
    expect(ev!.attributes).toMatchObject({ merged: true, state: 'closed', action: 'closed' });
    expect(ev!.occurredAt).toBe('2026-09-27T11:40:01.000Z');
  });

  it('maps closed without a merge to github.pr.closed', async () => {
    const [ev] = await parse(
      deliver(prMerged, (b) => {
        b.pull_request.merged = false;
        b.pull_request.merged_at = null;
      }),
    );
    expect(ev!.type).toBe('github.pr.closed');
    expect(ev!.attributes.merged).toBe(false);
  });

  it('maps synchronize with the new head sha in the version', async () => {
    const [ev] = await parse(
      deliver(prOpened, (b) => {
        b.action = 'synchronize';
        b.before = '6dcb09b5b57875f334f61aebed695e2e4193db5e';
        b.after = 'ffe1a4d6a9e2f3b0c8d7e6f5a4b3c2d1e0f9a8b7';
      }),
    );
    expect(ev!.type).toBe('github.pr.synchronize');
    expect(ev!.attributes.headSha).toBe('ffe1a4d6a9e2f3b0c8d7e6f5a4b3c2d1e0f9a8b7');
    expect(ev!.artifact.version).toBe(
      '2026-09-27T10:02:13Z:ffe1a4d6a9e2f3b0c8d7e6f5a4b3c2d1e0f9a8b7',
    );
  });

  it('maps pull_request_review.submitted', async () => {
    const [ev] = await parse(deliver(prReview));
    expect(ev).toMatchObject({
      type: 'github.pr.review_submitted',
      occurredAt: '2026-09-27T11:02:55.000Z',
      artifact: { kind: 'github.pr', id: 'acme/api#482', version: 'review:2310044871' },
      attributes: {
        reviewState: 'approved',
        reviewer: 'monalisa',
        action: 'submitted',
        number: 482,
      },
    });
    expect(await parse(deliver(prReview, (b) => (b.action = 'dismissed')))).toEqual([]);
  });

  it('ignores pull request actions it does not declare', async () => {
    for (const action of ['edited', 'assigned', 'review_requested', 'converted_to_draft']) {
      expect(await parse(deliver(prOpened, (b) => (b.action = action)))).toEqual([]);
    }
  });
});

describe('github parse: other events', () => {
  it('maps issues.labeled', async () => {
    const [ev] = await parse(deliver(issueLabeled));
    expect(ev).toEqual({
      type: 'github.issue.labeled',
      occurredAt: '2026-09-27T09:12:00.000Z',
      artifact: {
        kind: 'github.issue',
        id: 'acme/api#12',
        url: 'https://github.com/acme/api/issues/12',
        version: '2026-09-27T09:12:00Z:triage',
      },
      attributes: {
        repo: 'acme/api',
        number: 12,
        title: 'Webhook retries hammer the queue',
        author: 'hubot',
        state: 'open',
        labels: ['bug', 'triage'],
        label: 'triage',
        action: 'labeled',
        sender: 'octocat',
      },
      deliveryId: 'c41f2e00-7c70-11ef-9d3c-4b5a6c7d8e9f',
      dedupeKey: 'github.issue.labeled:github.issue:acme/api#12:2026-09-27T09:12:00Z:triage',
    });
  });

  it('maps issues opened, closed, reopened and unlabeled', async () => {
    for (const action of ['opened', 'closed', 'reopened', 'unlabeled']) {
      const [ev] = await parse(deliver(issueLabeled, (b) => (b.action = action)));
      expect(ev!.type).toBe(`github.issue.${action}`);
    }
    expect(await parse(deliver(issueLabeled, (b) => (b.action = 'transferred')))).toEqual([]);
  });

  it('maps check_suite.completed', async () => {
    const [ev] = await parse(deliver(checkSuiteCompleted));
    expect(ev).toMatchObject({
      type: 'github.check_suite.completed',
      artifact: {
        kind: 'github.check_suite',
        id: 'acme/api/check-suites/27744188321',
        version: '2026-09-27T10:09:47Z',
      },
      attributes: {
        repo: 'acme/api',
        conclusion: 'failure',
        status: 'completed',
        headBranch: 'feat/retry-backoff',
        headSha: '6dcb09b5b57875f334f61aebed695e2e4193db5e',
        app: 'github-actions',
        pullRequests: ['acme/api#482'],
        sender: 'github-actions[bot]',
      },
    });
    expect(await parse(deliver(checkSuiteCompleted, (b) => (b.action = 'requested')))).toEqual([]);
  });

  it('maps release.published and ignores other release actions', async () => {
    const [ev] = await parse(deliver(releasePublished));
    expect(ev).toMatchObject({
      type: 'github.release.published',
      artifact: {
        kind: 'github.release',
        id: 'acme/api@v2.14.0',
        url: 'https://github.com/acme/api/releases/tag/v2.14.0',
        version: '2026-09-27T12:01:17Z',
      },
      attributes: {
        tag: 'v2.14.0',
        name: 'v2.14.0 — retries',
        prerelease: false,
        draft: false,
        author: 'octocat',
      },
    });
    expect(await parse(deliver(releasePublished, (b) => (b.action = 'created')))).toEqual([]);
  });

  it('maps push with the head commit as the version', async () => {
    const [ev] = await parse(deliver(push));
    expect(ev).toEqual({
      type: 'github.push',
      occurredAt: '2026-09-27T11:40:01.000Z',
      artifact: {
        kind: 'github.push',
        id: 'acme/api:refs/heads/main',
        url: 'https://github.com/acme/api/compare/9049f1265b7d...0d1a26e67d8f',
        version: '0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c',
      },
      attributes: {
        repo: 'acme/api',
        action: 'push',
        sender: 'monalisa',
        ref: 'refs/heads/main',
        branch: 'main',
        tag: '',
        before: '9049f1265b7d61be4a8904a9a27120d2064dab3b',
        after: '0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c',
        commits: 1,
        forced: false,
        created: false,
        deleted: false,
        pusher: 'monalisa',
      },
      deliveryId: '1a2b3c4d-7c86-11ef-9f8e-7d6c5b4a3f2e',
      dedupeKey:
        'github.push:github.push:acme/api:refs/heads/main:0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c',
    });
  });

  it('maps a tag push and a branch deletion (no head commit)', async () => {
    const [tag] = await parse(deliver(push, (b) => (b.ref = 'refs/tags/v2.14.0')));
    expect(tag!.attributes).toMatchObject({ tag: 'v2.14.0', branch: '' });
    const [deleted] = await parse(
      deliver(push, (b) => {
        b.ref = 'refs/heads/feat/retry-backoff';
        b.after = '0000000000000000000000000000000000000000';
        b.deleted = true;
        b.commits = [];
        b.head_commit = null;
      }),
    );
    expect(deleted!.artifact.version).toBe('0000000000000000000000000000000000000000');
    expect(deleted!.attributes).toMatchObject({
      deleted: true,
      commits: 0,
      branch: 'feat/retry-backoff',
    });
    expect(deleted!.occurredAt).toBe('2026-09-27T12:00:01.000Z');
  });

  it('yields nothing for ping, unknown events and bodies that are not JSON objects', async () => {
    expect(await parse(deliver(ping))).toEqual([]);
    expect(await parse(deliver({ ...prOpened, event: 'star' }))).toEqual([]);
    expect(
      await parse(rawRequest({ headers: { 'x-github-event': 'push' }, body: 'not json' })),
    ).toEqual([]);
    expect(
      await parse(rawRequest({ headers: { 'x-github-event': 'push' }, body: '[1,2]' })),
    ).toEqual([]);
    expect(await parse(rawRequest({ body: JSON.stringify(push.body) }))).toEqual([]);
  });

  it('applies the repository allowlist by short or full name', async () => {
    const only = (repositories: string[]) => ({ ...tokenSettings, repositories });
    expect(await parse(deliver(prOpened), only(['web']))).toEqual([]);
    expect(await parse(deliver(prOpened), only(['api']))).toHaveLength(1);
    expect(await parse(deliver(prOpened), only(['ACME/API']))).toHaveLength(1);
    expect(await parse(deliver(prOpened), only(['other/api']))).toEqual([]);
  });

  it('falls back to the delivery id when there is no version', async () => {
    const [ev] = await parse(
      deliver(releasePublished, (b) => {
        delete b.release.published_at;
      }),
    );
    expect(ev!.dedupeKey).toBe(
      'github.release.published:github.release:acme/api@v2.14.0:0f9e8d7c-7c90-11ef-8b6a-3c4d5e6f7a8b',
    );
  });
});

describe('github resolve', () => {
  it('returns a live snapshot of a pull request', async () => {
    const { source, calls } = make();
    const snap = await source.resolve!({ kind: 'github.pr', id: 'acme/api#482' });
    expect(snap).toEqual({
      ref: {
        kind: 'github.pr',
        id: 'acme/api#482',
        url: 'https://github.com/acme/api/pull/482',
        version: '2026-09-27T10:05:31Z',
      },
      state: 'open',
      title: 'Retry webhook deliveries with backoff',
      labels: ['backend', 'needs-review'],
      draft: true,
      merged: false,
      url: 'https://github.com/acme/api/pull/482',
      updatedAt: '2026-09-27T10:05:31Z',
    });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('returns an issue snapshot, and null for 404 and 410', async () => {
    const { source } = make(
      tokenSettings,
      githubApi((req) =>
        req.url.pathname === '/repos/acme/api/issues/13'
          ? { status: 410, json: { message: 'Gone' } }
          : undefined,
      ),
    );
    const snap = await source.resolve!({ kind: 'github.issue', id: 'acme/api#12' });
    expect(snap).toMatchObject({
      state: 'open',
      labels: ['bug', 'triage'],
      draft: false,
      merged: false,
    });
    expect(await source.resolve!({ kind: 'github.issue', id: 'acme/api#404' })).toBeNull();
    expect(await source.resolve!({ kind: 'github.issue', id: 'acme/api#13' })).toBeNull();
  });

  it('throws on server errors and on kinds it cannot look up', async () => {
    const { source } = make(tokenSettings, () => ({
      status: 502,
      json: { message: 'Bad gateway' },
    }));
    await expect(source.resolve!({ kind: 'github.pr', id: 'acme/api#482' })).rejects.toThrow(/502/);
    await expect(source.resolve!({ kind: 'github.release', id: 'acme/api@v1' })).rejects.toThrow(
      /cannot look up/,
    );
    await expect(source.resolve!({ kind: 'github.pr', id: '482' })).rejects.toThrow(
      /cannot look up/,
    );
  });
});

describe('github linked', () => {
  it('reads tracker references from the live pull request text', async () => {
    const { source } = make();
    expect(await source.linked!({ kind: 'github.pr', id: 'acme/api#482' })).toEqual([
      { kind: 'github.issue', id: 'acme/api#12' },
      { kind: 'linear.issue', id: 'LOL-1712' },
    ]);
  });

  it('returns nothing for a pull request that is gone', async () => {
    const { source } = make();
    expect(await source.linked!({ kind: 'github.pr', id: 'acme/api#999' })).toEqual([]);
  });

  it('extracts Linear ids, closing keywords, cross-repo refs and links', () => {
    const text = [
      'Closes acme/web#7 and resolves: #3.',
      'Tracks [LOL-1712](https://linear.app/acme/issue/LOL-1712/retry) and ENG-42.',
      'See also octo/infra#99, https://github.com/acme/api/pull/481 and https://github.com/acme/web/issues/8.',
      'Not links: UTF-8, SHA-256, RFC-7231, lol-12, ABCDEFGH-1, a#1, #5 alone, acme/api#482 (self).',
      'Inline `FOO-1` and fenced:\n```\nBAR-2 fixes #77\n```',
      'Duplicate: LOL-1712, fixes #3',
    ].join('\n');
    expect(extractLinks(text, 'acme/api', 'acme/api#482')).toEqual([
      { kind: 'github.issue', id: 'acme/web#7' },
      { kind: 'github.issue', id: 'acme/api#3' },
      { kind: 'linear.issue', id: 'LOL-1712' },
      { kind: 'linear.issue', id: 'ENG-42' },
      { kind: 'github.issue', id: 'octo/infra#99' },
      { kind: 'github.pr', id: 'acme/api#481' },
      { kind: 'github.issue', id: 'acme/web#8' },
    ]);
  });
});

describe('github act', () => {
  const pr = { kind: 'github.pr', id: 'acme/api#482' };

  function recorder(reply: StubHandler = () => ({ status: 200, json: [] })) {
    return make(
      tokenSettings,
      githubApi(async (req) =>
        req.url.pathname.startsWith('/repos/acme/api/issues/482') || req.url.pathname === '/graphql'
          ? reply(req)
          : undefined,
      ),
    );
  }

  it('addLabel posts the label to the issues endpoint', async () => {
    const { source, calls } = recorder(() => ({
      json: [{ name: 'backend' }, { name: 'ship-it' }],
    }));
    const result = await source.act!('addLabel', { artifact: pr, label: 'ship-it' });
    expect(result).toMatchObject({ ok: true, data: { labels: ['backend', 'ship-it'] } });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe('/repos/acme/api/issues/482/labels');
    expect(calls[0]!.json()).toEqual({ labels: ['ship-it'] });
  });

  it('removeLabel deletes the encoded label and treats an absent label as success', async () => {
    const { source, calls } = recorder(() => ({
      status: 404,
      json: { message: 'Label does not exist' },
    }));
    const result = await source.act!('removeLabel', { artifact: pr, label: 'needs review/qa' });
    expect(result.ok).toBe(true);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url.pathname).toBe('/repos/acme/api/issues/482/labels/needs%20review%2Fqa');
  });

  it('comment posts the body and returns the comment url', async () => {
    const { source, calls } = recorder(() => ({
      status: 201,
      json: { id: 998877, html_url: 'https://github.com/acme/api/pull/482#issuecomment-998877' },
    }));
    const result = await source.act!('comment', {
      artifact: { kind: 'github.issue', id: 'acme/api#482' },
      body: 'Queued a run.',
    });
    expect(result).toEqual({
      ok: true,
      message: 'Commented on acme/api#482',
      data: { id: 998877, url: 'https://github.com/acme/api/pull/482#issuecomment-998877' },
    });
    expect(calls[0]!.json()).toEqual({ body: 'Queued a run.' });
  });

  it('markReady runs the GraphQL mutation with the PR node id when it is a draft', async () => {
    const { source, calls } = recorder(() => ({
      json: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } },
    }));
    expect(await source.act!('markReady', { artifact: pr })).toMatchObject({ ok: true });
    const gql = calls.find((c) => c.url.pathname === '/graphql')!;
    expect(gql.json()).toMatchObject({ variables: { id: 'PR_kwDOIMpVxM55FbL8' } });
    expect(gql.json<{ query: string }>().query).toContain('markPullRequestReadyForReview');
  });

  it('markReady is a no-op for a PR that is not a draft, and reports GraphQL errors', async () => {
    const ready = make(
      tokenSettings,
      githubApi((req) =>
        req.url.pathname === '/repos/acme/api/pulls/482'
          ? { json: { ...apiResponses.pull, draft: false } }
          : undefined,
      ),
    );
    expect(await ready.source.act!('markReady', { artifact: pr })).toMatchObject({
      ok: true,
      message: expect.stringContaining('already') as string,
    });
    expect(ready.calls.some((c) => c.url.pathname === '/graphql')).toBe(false);

    const failing = recorder(() => ({
      json: { errors: [{ message: 'Resource not accessible by integration' }] },
    }));
    expect(await failing.source.act!('markReady', { artifact: pr })).toEqual({
      ok: false,
      message: 'markReady failed: GitHub answered 200 (Resource not accessible by integration)',
    });
  });

  it('refuses invalid args, unknown actions and markReady on an issue', async () => {
    const { source, calls } = recorder();
    expect((await source.act!('addLabel', { artifact: pr })).ok).toBe(false);
    expect(
      (await source.act!('addLabel', { artifact: { kind: 'github.pr', id: '482' }, label: 'x' }))
        .ok,
    ).toBe(false);
    expect(
      (await source.act!('markReady', { artifact: { kind: 'github.issue', id: 'acme/api#12' } }))
        .ok,
    ).toBe(false);
    expect(await source.act!('merge', { artifact: pr })).toEqual({
      ok: false,
      message: 'Unknown action "merge"',
    });
    expect(calls).toHaveLength(0);
  });

  it('reports a GitHub refusal with its message', async () => {
    const { source } = recorder(() => ({
      status: 403,
      json: { message: 'Must have admin rights to Repository.' },
    }));
    expect(await source.act!('addLabel', { artifact: pr, label: 'x' })).toEqual({
      ok: false,
      message: 'addLabel failed: GitHub answered 403 (Must have admin rights to Repository.)',
    });
  });
});

describe('github provision', () => {
  it('creates one organization hook with the secret and the needed events', async () => {
    const { source, calls } = make(tokenSettings, (req) =>
      req.url.pathname === '/orgs/acme/hooks'
        ? { status: 201, json: { id: 501234987 } }
        : undefined,
    );
    const result = await source.provision!('https://switchboard.example.com/hooks/src_1');
    expect(result).toEqual({
      ok: true,
      externalId: 'orgs/acme/hooks/501234987',
      message: 'Created orgs/acme/hooks/501234987',
    });
    expect(calls[0]!.json()).toEqual({
      name: 'web',
      active: true,
      events: ['pull_request', 'pull_request_review', 'issues', 'check_suite', 'release', 'push'],
      config: {
        url: 'https://switchboard.example.com/hooks/src_1',
        content_type: 'json',
        secret: SECRET,
        insecure_ssl: '0',
      },
    });
  });

  it('does not throw after a side effect when GitHub answers 2xx without JSON', async () => {
    const { source } = make(tokenSettings, (req) =>
      req.url.pathname.endsWith('/hooks') || req.url.pathname.endsWith('/comments')
        ? { status: 201, body: '<html>proxy says ok</html>' }
        : undefined,
    );
    const hooked = await source.provision!('https://switchboard.example.com/hooks/src_1');
    expect(hooked.ok).toBe(true);
    const commented = await source.act!('comment', {
      artifact: { kind: 'github.pr', id: 'acme/api#7' },
      body: 'hello',
    });
    expect(commented).toMatchObject({ ok: true, message: 'Commented on acme/api#7' });
  });

  it('creates repository hooks for an allowlist and reports a partial failure', async () => {
    const s = { ...tokenSettings, repositories: ['api', 'acme/web', 'mobile'] };
    const { source, calls } = make(s, (req) => {
      if (req.url.pathname === '/repos/acme/api/hooks') return { status: 201, json: { id: 1 } };
      if (req.url.pathname === '/repos/acme/web/hooks') return { status: 201, json: { id: 2 } };
      return { status: 422, json: { message: 'Hook already exists on this repository' } };
    });
    const result = await source.provision!('https://switchboard.example.com/hooks/src_1');
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/repos/acme/api/hooks',
      '/repos/acme/web/hooks',
      '/repos/acme/mobile/hooks',
    ]);
    expect(result.ok).toBe(false);
    expect(result.externalId).toBe('repos/acme/api/hooks/1,repos/acme/web/hooks/2');
    expect(result.message).toContain('Hook already exists');
  });
});

describe('github health', () => {
  it('is healthy when the rate limit endpoint answers', async () => {
    expect(await make().source.health()).toEqual({
      status: 'healthy',
      message: '4987 API requests left this hour',
      checkedAt: NOW.toISOString(),
    });
  });

  it('is unhealthy on a refusal or a network failure', async () => {
    const refused = make(tokenSettings, () => ({
      status: 401,
      json: { message: 'Bad credentials' },
    }));
    expect(await refused.source.health()).toMatchObject({
      status: 'unhealthy',
      message: 'GitHub answered 401 (Bad credentials)',
    });
    const down = make(tokenSettings, () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    expect((await down.source.health()).status).toBe('unhealthy');
  });
});

describe('github App authentication', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const appSettings: Settings = {
    authMode: 'app',
    appId: '123456',
    installationId: '7890',
    privateKey: pem,
    owner: 'acme',
    webhookSecret: SECRET,
  };

  function appApi(
    tokens: string[] = ['ghs_fixtureInstallationToken1', 'ghs_fixtureInstallationToken2'],
  ): StubHandler {
    let issued = 0;
    return githubApi((req) => {
      if (req.url.pathname !== '/app/installations/7890/access_tokens') return undefined;
      const jwt = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const [h = '', p = '', sig = ''] = jwt.split('.');
      const valid = verifySignature(
        'sha256',
        Buffer.from(`${h}.${p}`),
        publicKey,
        Buffer.from(sig, 'base64url'),
      );
      if (!valid || req.method !== 'POST')
        return { status: 401, json: { message: 'A JSON web token could not be decoded' } };
      const token = tokens[issued++] ?? 'ghs_exhausted';
      return {
        status: 201,
        json: { token, expires_at: new Date(NOW.getTime() + 3_600_000).toISOString() },
      };
    });
  }

  it('signs an RS256 JWT for the App and uses the installation token', async () => {
    const { source, calls } = make(appSettings, appApi());
    expect((await source.health()).status).toBe('healthy');
    const exchange = calls[0]!;
    const [header, payload] = (exchange.headers.authorization ?? '')
      .replace('Bearer ', '')
      .split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as {
      iat: number;
      exp: number;
      iss: string;
    };
    expect(claims.iss).toBe('123456');
    expect(claims.iat).toBe(Math.floor(NOW.getTime() / 1000) - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(calls[1]!.headers.authorization).toBe('Bearer ghs_fixtureInstallationToken1');
  });

  it('caches the installation token in memory until a minute before it expires', async () => {
    let now = NOW;
    const stub = createStubHttp(appApi());
    const state = createMemoryState();
    const source = githubSource.create(
      appSettings,
      createTestContext({ http: stub.client, now: () => now, state }),
    );
    await source.resolve!({ kind: 'github.pr', id: 'acme/api#482' });
    await source.resolve!({ kind: 'github.pr', id: 'acme/api#482' });
    const exchanges = () =>
      stub.calls.filter((c) => c.url.pathname.endsWith('/access_tokens')).length;
    expect(exchanges()).toBe(1);
    now = new Date(NOW.getTime() + 3_600_000 - 59_000);
    await source.resolve!({ kind: 'github.pr', id: 'acme/api#482' });
    expect(exchanges()).toBe(2);
    expect(stub.calls.at(-1)!.headers.authorization).toBe('Bearer ghs_fixtureInstallationToken2');
    expect(state.data).toEqual({});
  });

  it('shares one exchange between concurrent calls', async () => {
    const { source, calls } = make(appSettings, appApi());
    await Promise.all([
      source.resolve!({ kind: 'github.pr', id: 'acme/api#482' }),
      source.resolve!({ kind: 'github.issue', id: 'acme/api#12' }),
    ]);
    expect(calls.filter((c) => c.url.pathname.endsWith('/access_tokens'))).toHaveLength(1);
  });

  it('accepts a key pasted with literal \\n sequences', async () => {
    const { source } = make({ ...appSettings, privateKey: pem.replace(/\n/g, '\\n') }, appApi());
    expect((await source.health()).status).toBe('healthy');
  });

  it('reports a refused exchange or a broken key as unhealthy', async () => {
    const wrongInstallation = make({ ...appSettings, installationId: '1' }, appApi());
    expect(await wrongInstallation.source.health()).toMatchObject({
      status: 'unhealthy',
      message: expect.stringContaining('installation token (404)') as string,
    });
    const badKey = make(
      {
        ...appSettings,
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----',
      },
      appApi(),
    );
    expect(await badKey.source.health()).toMatchObject({
      status: 'unhealthy',
      message: expect.stringContaining('not a valid PEM key') as string,
    });
  });
});
