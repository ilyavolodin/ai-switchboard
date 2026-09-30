import {
  asNumber,
  asObject,
  asString,
  checkHealth,
  dispatchAction,
  getPath,
  parseJsonObject,
  verifyHmacHeader,
  withSettings,
  type ActionResult,
  type ArtifactRef,
  type ArtifactSnapshot,
  type Health,
  type JsonObject,
  type PluginContext,
  type ProvisionResult,
  type RawRequest,
  type Source,
  type SourceType,
  type VerifyResult,
} from '@ai-switchboard/sdk';

import { actions, type LinearActionArgs } from './actions.js';
import {
  COMMENT_CREATE,
  createApi,
  ISSUE_QUERY,
  ISSUE_UPDATE,
  LABELS_QUERY,
  LinearApiError,
  nodes,
  STATES_QUERY,
  TEAMS_QUERY,
  VIEWER_QUERY,
  WEBHOOK_CREATE,
  type LinearApi,
} from './api.js';
import { eventTypes } from './events.js';
import { labelNames, parseDelivery } from './parse.js';
import { LinearSettingsError, settingsSchema, type LinearSettings } from './settings.js';

/** Linear's documented replay window: reject deliveries whose timestamp is further off. */
export const MAX_SKEW_MS = 60_000;

/**
 * Linear-Signature is the hex HMAC-SHA256 of the raw body; `webhookTimestamp` (ms, in the body)
 * must be within a minute of now so a captured delivery cannot be replayed later.
 */
export function verifyDelivery(secret: string, req: RawRequest, now: Date): VerifyResult {
  const signed = verifyHmacHeader(req, { header: 'linear-signature', secret });
  if (!signed.ok) return signed;
  const timestamp = asNumber(parseJsonObject(req.body.toString('utf8'))?.webhookTimestamp);
  if (timestamp === undefined) return { ok: false, reason: 'missing webhookTimestamp' };
  if (Math.abs(now.getTime() - timestamp) > MAX_SKEW_MS) {
    return { ok: false, reason: 'webhookTimestamp is more than 60 s from now' };
  }
  return { ok: true };
}

function createLinearSource(s: LinearSettings, ctx: PluginContext): Source {
  const api: LinearApi = createApi(ctx.http, s.apiKey);

  async function fetchIssue(id: string): Promise<JsonObject | null> {
    try {
      const data = await api.graphql(ISSUE_QUERY, { id });
      return asObject(data.issue) ?? null;
    } catch (err) {
      if (err instanceof LinearApiError && err.notFound) return null;
      throw err;
    }
  }

  async function withIssue(
    ref: ArtifactRef,
    run: (issue: JsonObject) => Promise<ActionResult>,
  ): Promise<ActionResult> {
    const issue = await fetchIssue(ref.id);
    if (!issue) return { ok: false, message: `${ref.id} was not found` };
    try {
      return await run(issue);
    } catch (err) {
      if (err instanceof LinearApiError) return { ok: false, message: err.message };
      throw err;
    }
  }

  async function update(
    issue: JsonObject,
    input: JsonObject,
    message: string,
  ): Promise<ActionResult> {
    const data = await api.graphql(ISSUE_UPDATE, { id: asString(issue.id) ?? '', input });
    return getPath(data, 'issueUpdate', 'success') === true
      ? { ok: true, message }
      : { ok: false, message: 'Linear did not apply the update' };
  }

  const handlers = {
    addLabel: (a: LinearActionArgs) =>
      withIssue(a.artifact, async (issue) => {
        const id = a.artifact.id;
        const wanted = (a.label ?? '').toLowerCase();
        if (labelNames(getPath(issue, 'labels', 'nodes')).some((l) => l.toLowerCase() === wanted)) {
          return { ok: true, message: `${id} already has label ${a.label ?? ''}` };
        }
        const teamId = asString(getPath(issue, 'team', 'id'));
        const candidates = nodes((await api.graphql(LABELS_QUERY, { name: a.label })).issueLabels);
        // Prefer the issue's team label over a workspace label of the same name.
        const label =
          candidates.find((l) => asString(getPath(l, 'team', 'id')) === teamId) ??
          candidates.find((l) => getPath(l, 'team') == null);
        const labelId = asString(label?.id);
        if (labelId === undefined)
          return {
            ok: false,
            message: `No label named ${a.label ?? ''} in the issue's team or workspace`,
          };
        // Only the addition: a full label list would drop a label added since the fetch.
        return update(
          issue,
          { addedLabelIds: [labelId] },
          `Added label ${asString(label?.name) ?? ''} to ${id}`,
        );
      }),
    setState: (a: LinearActionArgs) =>
      withIssue(a.artifact, async (issue) => {
        const id = a.artifact.id;
        const teamId = asString(getPath(issue, 'team', 'id')) ?? '';
        const states = nodes(
          (await api.graphql(STATES_QUERY, { teamId, name: a.state })).workflowStates,
        );
        const stateId = asString(states[0]?.id);
        if (stateId === undefined)
          return {
            ok: false,
            message: `No workflow state named ${a.state ?? ''} in the issue's team`,
          };
        if (asString(getPath(issue, 'state', 'id')) === stateId)
          return { ok: true, message: `${id} is already in ${a.state ?? ''}` };
        return update(issue, { stateId }, `Moved ${id} to ${asString(states[0]?.name) ?? ''}`);
      }),
    comment: (a: LinearActionArgs) =>
      withIssue(a.artifact, async (issue) => {
        const data = await api.graphql(COMMENT_CREATE, {
          input: { issueId: asString(issue.id) ?? '', body: a.body },
        });
        const comment = asObject(getPath(data, 'commentCreate', 'comment'));
        return getPath(data, 'commentCreate', 'success') === true
          ? {
              ok: true,
              message: `Commented on ${a.artifact.id}`,
              data: { id: asString(comment?.id), url: asString(comment?.url) },
            }
          : { ok: false, message: 'Linear did not create the comment' };
      }),
  };

  async function provision(webhookUrl: string): Promise<ProvisionResult> {
    const base = {
      url: webhookUrl,
      resourceTypes: ['Issue', 'Comment'],
      secret: s.webhookSecret,
      label: 'AI Switchboard',
    };
    let inputs: JsonObject[] = [{ ...base, allPublicTeams: true }];
    try {
      if (s.teamKeys.length > 0) {
        const teams = nodes((await api.graphql(TEAMS_QUERY, { keys: s.teamKeys })).teams);
        const missing = s.teamKeys.filter(
          (k) => !teams.some((t) => asString(t.key)?.toLowerCase() === k.toLowerCase()),
        );
        if (missing.length > 0)
          return { ok: false, message: `Unknown team keys: ${missing.join(', ')}` };
        inputs = teams.map((t) => ({ ...base, teamId: asString(t.id) }));
      }
      const created: string[] = [];
      for (const input of inputs) {
        const data = await api.graphql(WEBHOOK_CREATE, { input });
        const webhookId = asString(getPath(data, 'webhookCreate', 'webhook', 'id'));
        if (getPath(data, 'webhookCreate', 'success') !== true || webhookId === undefined) {
          return {
            ok: false,
            ...(created.length > 0 ? { externalId: created.join(',') } : {}),
            message: 'Linear did not create the webhook',
          };
        }
        created.push(webhookId);
      }
      return {
        ok: true,
        externalId: created.join(','),
        message: `Created ${created.length} Linear webhook(s)`,
      };
    } catch (err) {
      if (err instanceof LinearApiError) return { ok: false, message: err.message };
      throw err;
    }
  }

  async function resolve(ref: ArtifactRef): Promise<ArtifactSnapshot | null> {
    if (ref.kind !== 'linear.issue') throw new LinearApiError(`linear cannot look up ${ref.kind}`);
    const issue = await fetchIssue(ref.id);
    if (!issue) return null;
    const url = asString(issue.url) ?? '';
    const updatedAt = asString(issue.updatedAt) ?? '';
    return {
      ref: {
        kind: 'linear.issue',
        id: asString(issue.identifier) ?? ref.id,
        url,
        version: updatedAt,
      },
      title: asString(issue.title) ?? '',
      state: asString(getPath(issue, 'state', 'name')) ?? '',
      stateType: asString(getPath(issue, 'state', 'type')) ?? '',
      labels: labelNames(getPath(issue, 'labels', 'nodes')),
      priority: asNumber(issue.priority) ?? 0,
      assignee: asString(getPath(issue, 'assignee', 'name')) ?? null,
      url,
      updatedAt,
    };
  }

  function health(): Promise<Health> {
    return checkHealth(ctx, async () => {
      const data = await api.graphql(VIEWER_QUERY);
      const name = asString(getPath(data, 'viewer', 'name'));
      return {
        status: 'healthy',
        ...(name !== undefined ? { message: `Authenticated as ${name}` } : {}),
      };
    });
  }

  return {
    verify: (req) => verifyDelivery(s.webhookSecret, req, ctx.now()),
    parse: (req) => parseDelivery(req, s.teamKeys),
    provision,
    resolve,
    act: (action, args) => dispatchAction(actions, handlers, action, args),
    health,
  };
}

export const linearSource: SourceType = {
  id: 'linear',
  displayName: 'Linear',
  icon: 'issue',
  description:
    'Linear issue and comment webhooks, with label and state changes derived per change, plus live state and actions.',
  mode: 'push',
  settingsSchema,
  eventTypes,
  actions,
  create: withSettings(settingsSchema, 'linear settings', createLinearSource, {
    error: LinearSettingsError,
  }),
};
