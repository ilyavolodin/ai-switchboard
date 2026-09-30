import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  checkHealth,
  dispatchAction,
  tryJson,
  verifyHmacHeader,
  withSettings,
  type ActionResult,
  type ArtifactRef,
  type ArtifactSnapshot,
  type Health,
  type JsonObject,
  type PluginContext,
  type ProvisionResult,
  type Source,
  type SourceType,
} from '@ai-switchboard/sdk';

import { actions, itemPath, numberedOrThrow, type GitHubActionArgs } from './actions.js';
import {
  createApi,
  createAuth,
  errorMessage,
  GitHubApiError,
  MARK_READY,
  type GitHubApi,
} from './api.js';
import { WEBHOOK_EVENTS, eventTypes } from './events.js';
import { extractLinks } from './links.js';
import { labelNames, parseDelivery } from './parse.js';
import { GitHubSettingsError, settingsSchema, type GitHubSettings } from './settings.js';

function refusal(what: string, res: { status: number }, message: string): ActionResult {
  return { ok: false, message: `${what} failed: GitHub answered ${res.status} (${message})` };
}

function snapshot(ref: ArtifactRef, item: JsonObject): ArtifactSnapshot {
  const updatedAt = asString(item.updated_at) ?? '';
  const url = asString(item.html_url) ?? '';
  return {
    ref: { kind: ref.kind, id: ref.id, url, version: updatedAt },
    state: asString(item.state) ?? '',
    title: asString(item.title) ?? '',
    labels: labelNames(item.labels),
    draft: asBoolean(item.draft) ?? false,
    merged: asBoolean(item.merged) ?? false,
    url,
    updatedAt,
  };
}

function createGitHubSource(s: GitHubSettings, ctx: PluginContext): Source {
  const api: GitHubApi = createApi(ctx.http, createAuth(s, ctx));

  async function fetchItem(ref: ArtifactRef): Promise<JsonObject | null> {
    const n = numberedOrThrow(ref);
    const res = await api.request('GET', itemPath(n, ref.kind));
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok)
      throw new GitHubApiError(`GitHub answered ${res.status} for ${ref.id}: ${errorMessage(res)}`);
    return asObject(res.json()) ?? null;
  }

  const issuePath = (artifact: ArtifactRef): string => {
    const n = numberedOrThrow(artifact);
    return `/repos/${n.owner}/${n.repo}/issues/${n.number}`;
  };

  const handlers = {
    async addLabel(a: GitHubActionArgs): Promise<ActionResult> {
      const res = await api.request('POST', `${issuePath(a.artifact)}/labels`, {
        labels: [a.label],
      });
      return res.ok
        ? {
            ok: true,
            message: `Added label ${a.label ?? ''} to ${a.artifact.id}`,
            data: { labels: labelNames(tryJson(res)) },
          }
        : refusal('addLabel', res, errorMessage(res));
    },
    async removeLabel(a: GitHubActionArgs): Promise<ActionResult> {
      const res = await api.request(
        'DELETE',
        `${issuePath(a.artifact)}/labels/${encodeURIComponent(a.label ?? '')}`,
      );
      if (res.status === 404)
        return { ok: true, message: `${a.artifact.id} did not have label ${a.label ?? ''}` };
      return res.ok
        ? { ok: true, message: `Removed label ${a.label ?? ''} from ${a.artifact.id}` }
        : refusal('removeLabel', res, errorMessage(res));
    },
    async comment(a: GitHubActionArgs): Promise<ActionResult> {
      const res = await api.request('POST', `${issuePath(a.artifact)}/comments`, { body: a.body });
      if (!res.ok) return refusal('comment', res, errorMessage(res));
      const comment = asObject(tryJson(res));
      return {
        ok: true,
        message: `Commented on ${a.artifact.id}`,
        data: { id: asNumber(comment?.id), url: asString(comment?.html_url) },
      };
    },
    async markReady(a: GitHubActionArgs): Promise<ActionResult> {
      const pr = await fetchItem(a.artifact);
      if (!pr) return { ok: false, message: `${a.artifact.id} was not found` };
      if (asBoolean(pr.draft) !== true)
        return { ok: true, message: `${a.artifact.id} is already ready for review` };
      const res = await api.graphql(MARK_READY, { id: asString(pr.node_id) ?? '' });
      const body = res.ok ? asObject(tryJson(res)) : undefined;
      const errors = asArray(body?.errors);
      if (!res.ok || errors.length > 0) {
        const message = asString(asObject(errors[0])?.message) ?? errorMessage(res);
        return refusal('markReady', res, message);
      }
      return { ok: true, message: `Marked ${a.artifact.id} ready for review` };
    },
  };

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
      created.push(`${target.slice(1)}/${asNumber(asObject(tryJson(res))?.id) ?? ''}`);
    }
    return { ok: true, externalId: created.join(','), message: `Created ${created.join(', ')}` };
  }

  function health(): Promise<Health> {
    return checkHealth(ctx, async () => {
      const res = await api.request('GET', '/rate_limit');
      if (!res.ok)
        return {
          status: 'unhealthy',
          message: `GitHub answered ${res.status} (${errorMessage(res)})`,
        };
      const remaining = asNumber(asObject(asObject(tryJson(res))?.rate)?.remaining);
      return {
        status: 'healthy',
        ...(remaining !== undefined ? { message: `${remaining} API requests left this hour` } : {}),
      };
    });
  }

  return {
    verify: (req) =>
      verifyHmacHeader(req, {
        header: 'x-hub-signature-256',
        secret: s.webhookSecret,
        prefix: 'sha256=',
      }),
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
      const text = `${asString(item.title) ?? ''}\n${asString(item.body) ?? ''}`;
      return extractLinks(text, `${n.owner}/${n.repo}`, ref.id);
    },
    act: (action, args) => dispatchAction(actions, handlers, action, args),
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
  create: withSettings(settingsSchema, 'github settings', createGitHubSource, {
    error: GitHubSettingsError,
  }),
};
