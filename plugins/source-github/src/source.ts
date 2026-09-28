import {
  validateAgainst,
  verifyHmac,
  type ActionResult,
  type ActionSpec,
  type ArtifactRef,
  type ArtifactSnapshot,
  type Health,
  type JSONSchema,
  type PluginContext,
  type ProvisionResult,
  type RawRequest,
  type Settings,
  type Source,
  type SourceType,
  type VerifyResult,
} from '@ai-switchboard/sdk';

import { createApi, createAuth, errorMessage, jsonOf, type GitHubApi } from './api.js';
import { WEBHOOK_EVENTS, eventTypes } from './events.js';
import { arr, bool, num, obj, str, type Json } from './json.js';
import { extractLinks } from './links.js';
import { parseDelivery } from './parse.js';
import { readSettings, settingsSchema, type GitHubSettings } from './settings.js';

const NUMBERED_ID = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)#([0-9]+)$/;

interface Numbered {
  owner: string;
  repo: string;
  number: number;
}

/** `acme/api#482` → its parts; `undefined` for anything else. */
export function parseNumberedId(id: string): Numbered | undefined {
  const m = NUMBERED_ID.exec(id);
  if (!m) return undefined;
  const [, owner = '', repo = '', n = ''] = m;
  return { owner, repo, number: Number(n) };
}

const artifactArg = (kinds: string[]): JSONSchema => ({
  type: 'object',
  title: 'Artifact',
  description:
    'The pull request or issue to act on, e.g. `{ kind: "github.pr", id: "acme/api#482" }`.',
  required: ['kind', 'id'],
  properties: {
    kind: { type: 'string', enum: kinds },
    id: { type: 'string', pattern: NUMBERED_ID.source },
    url: { type: 'string' },
    version: { type: 'string' },
  },
});

const both = ['github.pr', 'github.issue'];

export const actions: ActionSpec[] = [
  {
    id: 'addLabel',
    // Repeating it leaves the same state, so a step in doubt may run again.
    idempotent: true,
    title: 'Add label',
    description: 'Add a label to a pull request or issue (created on the repository if missing).',
    describe: 'Add label {{label}}',
    argsSchema: {
      type: 'object',
      required: ['artifact', 'label'],
      properties: {
        artifact: artifactArg(both),
        label: {
          type: 'string',
          minLength: 1,
          maxLength: 50,
          title: 'Label',
          description: 'Label name.',
        },
      },
    },
  },
  {
    id: 'removeLabel',
    // Repeating it leaves the same state, so a step in doubt may run again.
    idempotent: true,
    title: 'Remove label',
    description: 'Remove a label from a pull request or issue. Removing an absent label succeeds.',
    describe: 'Remove label {{label}}',
    argsSchema: {
      type: 'object',
      required: ['artifact', 'label'],
      properties: {
        artifact: artifactArg(both),
        label: { type: 'string', minLength: 1, title: 'Label', description: 'Label name.' },
      },
    },
  },
  {
    id: 'markReady',
    // Repeating it leaves the same state, so a step in doubt may run again.
    idempotent: true,
    title: 'Mark ready for review',
    description: 'Take a draft pull request out of draft.',
    describe: 'Mark the pull request ready for review',
    argsSchema: {
      type: 'object',
      required: ['artifact'],
      properties: { artifact: artifactArg(['github.pr']) },
    },
  },
  {
    id: 'comment',
    title: 'Comment',
    description: 'Post a comment on a pull request or issue.',
    describe: 'Comment on the pull request or issue',
    argsSchema: {
      type: 'object',
      required: ['artifact', 'body'],
      properties: {
        artifact: artifactArg(both),
        body: {
          type: 'string',
          minLength: 1,
          maxLength: 65536,
          title: 'Body',
          description: 'Markdown comment text.',
        },
      },
    },
  },
];

const actionsById = new Map(actions.map((a) => [a.id, a]));

const MARK_READY = `mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } }
}`;

function labelNames(value: unknown): string[] {
  return arr(value).flatMap((l) => {
    const name = str(obj(l)?.name);
    return name === undefined ? [] : [name];
  });
}

function refusal(what: string, res: { status: number }, message: string): ActionResult {
  return { ok: false, message: `${what} failed: GitHub answered ${res.status} (${message})` };
}

function itemPath(n: Numbered, kind: string): string {
  const base = `/repos/${n.owner}/${n.repo}`;
  return kind === 'github.pr' ? `${base}/pulls/${n.number}` : `${base}/issues/${n.number}`;
}

function snapshot(ref: ArtifactRef, item: Json): ArtifactSnapshot {
  const updatedAt = str(item.updated_at) ?? '';
  const url = str(item.html_url) ?? '';
  return {
    ref: { kind: ref.kind, id: ref.id, url, version: updatedAt },
    state: str(item.state) ?? '',
    title: str(item.title) ?? '',
    labels: labelNames(item.labels),
    draft: bool(item.draft) ?? false,
    merged: bool(item.merged) ?? false,
    url,
    updatedAt,
  };
}

function verifySignature(secret: string, req: RawRequest): VerifyResult {
  const signature = req.headers['x-hub-signature-256'];
  if (signature === undefined || signature === '') {
    return { ok: false, reason: 'missing x-hub-signature-256 header' };
  }
  return verifyHmac({ secret, payload: req.body, signature, prefix: 'sha256=' })
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch' };
}

function numberedOrThrow(ref: ArtifactRef): Numbered {
  const n = parseNumberedId(ref.id);
  if (!n || (ref.kind !== 'github.pr' && ref.kind !== 'github.issue')) {
    throw new Error(`github cannot look up ${ref.kind} ${ref.id}; only github.pr and github.issue`);
  }
  return n;
}

function createGitHubSource(settings: Settings, ctx: PluginContext): Source {
  const s: GitHubSettings = readSettings(settings);
  const api: GitHubApi = createApi(ctx.http, createAuth(s, ctx));

  async function fetchItem(ref: ArtifactRef): Promise<Json | null> {
    const n = numberedOrThrow(ref);
    const res = await api.request('GET', itemPath(n, ref.kind));
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok)
      throw new Error(`GitHub answered ${res.status} for ${ref.id}: ${errorMessage(res)}`);
    return obj(res.json()) ?? null;
  }

  async function act(action: string, args: unknown): Promise<ActionResult> {
    const spec = actionsById.get(action);
    if (!spec) return { ok: false, message: `Unknown action "${action}"` };
    const check = validateAgainst(spec.argsSchema, args);
    if (!check.valid) return { ok: false, message: `Invalid args: ${check.errors.join('; ')}` };
    const a = args as { artifact: ArtifactRef; label?: string; body?: string };
    const n = numberedOrThrow(a.artifact);
    const issuePath = `/repos/${n.owner}/${n.repo}/issues/${n.number}`;
    switch (action) {
      case 'addLabel': {
        const res = await api.request('POST', `${issuePath}/labels`, { labels: [a.label] });
        return res.ok
          ? {
              ok: true,
              message: `Added label ${a.label ?? ''} to ${a.artifact.id}`,
              data: { labels: labelNames(jsonOf(res)) },
            }
          : refusal('addLabel', res, errorMessage(res));
      }
      case 'removeLabel': {
        const res = await api.request(
          'DELETE',
          `${issuePath}/labels/${encodeURIComponent(a.label ?? '')}`,
        );
        if (res.status === 404)
          return { ok: true, message: `${a.artifact.id} did not have label ${a.label ?? ''}` };
        return res.ok
          ? { ok: true, message: `Removed label ${a.label ?? ''} from ${a.artifact.id}` }
          : refusal('removeLabel', res, errorMessage(res));
      }
      case 'comment': {
        const res = await api.request('POST', `${issuePath}/comments`, { body: a.body });
        if (!res.ok) return refusal('comment', res, errorMessage(res));
        const comment = obj(jsonOf(res));
        return {
          ok: true,
          message: `Commented on ${a.artifact.id}`,
          data: { id: num(comment?.id), url: str(comment?.html_url) },
        };
      }
      case 'markReady': {
        const pr = await fetchItem(a.artifact);
        if (!pr) return { ok: false, message: `${a.artifact.id} was not found` };
        if (bool(pr.draft) !== true)
          return { ok: true, message: `${a.artifact.id} is already ready for review` };
        const res = await api.graphql(MARK_READY, { id: str(pr.node_id) ?? '' });
        const body = res.ok ? obj(jsonOf(res)) : undefined;
        const errors = arr(body?.errors);
        if (!res.ok || errors.length > 0) {
          const message = str(obj(errors[0])?.message) ?? errorMessage(res);
          return refusal('markReady', res, message);
        }
        return { ok: true, message: `Marked ${a.artifact.id} ready for review` };
      }
      default:
        return { ok: false, message: `Unknown action "${action}"` };
    }
  }

  async function provision(webhookUrl: string): Promise<ProvisionResult> {
    const hook = {
      name: 'web',
      active: true,
      events: [...WEBHOOK_EVENTS],
      config: { url: webhookUrl, content_type: 'json', secret: s.webhookSecret, insecure_ssl: '0' },
    };
    const targets =
      s.repositories.length > 0
        ? s.repositories.map((r) => `/repos/${r.includes('/') ? r : `${s.owner}/${r}`}/hooks`)
        : [`/orgs/${s.owner}/hooks`];
    const created: string[] = [];
    for (const target of targets) {
      const res = await api.request('POST', target, hook);
      if (!res.ok) {
        return {
          ok: false,
          ...(created.length > 0 ? { externalId: created.join(',') } : {}),
          message: `Creating ${target.slice(1)} failed: GitHub answered ${res.status} (${errorMessage(res)})${
            created.length > 0 ? `; already created ${created.join(', ')}` : ''
          }`,
        };
      }
      created.push(`${target.slice(1)}/${num(obj(jsonOf(res))?.id) ?? ''}`);
    }
    return { ok: true, externalId: created.join(','), message: `Created ${created.join(', ')}` };
  }

  async function health(): Promise<Health> {
    try {
      const res = await api.request('GET', '/rate_limit');
      const checkedAt = ctx.now().toISOString();
      if (!res.ok)
        return {
          status: 'unhealthy',
          message: `GitHub answered ${res.status} (${errorMessage(res)})`,
          checkedAt,
        };
      const remaining = num(obj(obj(jsonOf(res))?.rate)?.remaining);
      return {
        status: 'healthy',
        ...(remaining !== undefined ? { message: `${remaining} API requests left this hour` } : {}),
        checkedAt,
      };
    } catch (err) {
      return {
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        checkedAt: ctx.now().toISOString(),
      };
    }
  }

  return {
    verify: (req) => verifySignature(s.webhookSecret, req),
    parse: (req) => parseDelivery(req, s.repositories),
    provision,
    async resolve(ref) {
      const item = await fetchItem(ref);
      return item ? snapshot(ref, item) : null;
    },
    async linked(ref) {
      const item = await fetchItem(ref);
      if (!item) return [];
      const n = numberedOrThrow(ref);
      const text = `${str(item.title) ?? ''}\n${str(item.body) ?? ''}`;
      return extractLinks(text, `${n.owner}/${n.repo}`, ref.id);
    },
    act,
    health,
  };
}

export const githubSource: SourceType = {
  id: 'github',
  displayName: 'GitHub',
  icon: 'pr',
  description:
    'Pull requests, issues, check suites, releases and pushes from a GitHub organization, with label, comment and ready-for-review actions.',
  mode: 'push',
  settingsSchema,
  eventTypes,
  actions,
  create: createGitHubSource,
};
