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

import { createApi, LinearApiError, type LinearApi } from './api.js';
import { eventTypes } from './events.js';
import { arr, num, obj, parseJsonObject, path, str, type Json } from './json.js';
import { parseDelivery } from './parse.js';
import { readSettings, settingsSchema, type LinearSettings } from './settings.js';

/** Linear's documented replay window: reject deliveries whose timestamp is further off. */
export const MAX_SKEW_MS = 60_000;

const artifactArg: JSONSchema = {
  type: 'object',
  title: 'Artifact',
  description: 'The issue to act on, e.g. `{ kind: "linear.issue", id: "LOL-1712" }`.',
  required: ['kind', 'id'],
  properties: {
    kind: { const: 'linear.issue' },
    id: { type: 'string', minLength: 1 },
    url: { type: 'string' },
    version: { type: 'string' },
  },
};

export const actions: ActionSpec[] = [
  {
    id: 'addLabel',
    title: 'Add label',
    description: 'Add an existing label (team or workspace) to the issue, by name.',
    describe: 'Add label {{label}}',
    argsSchema: {
      type: 'object',
      required: ['artifact', 'label'],
      properties: {
        artifact: artifactArg,
        label: {
          type: 'string',
          minLength: 1,
          title: 'Label',
          description: 'Label name (case-insensitive).',
        },
      },
    },
  },
  {
    id: 'setState',
    title: 'Set state',
    description: 'Move the issue to a workflow state of its team, by name.',
    describe: 'Move to {{state}}',
    argsSchema: {
      type: 'object',
      required: ['artifact', 'state'],
      properties: {
        artifact: artifactArg,
        state: {
          type: 'string',
          minLength: 1,
          title: 'State',
          description: 'Workflow state name, e.g. `In Review`.',
        },
      },
    },
  },
  {
    id: 'comment',
    title: 'Comment',
    description: 'Post a comment on the issue.',
    describe: 'Comment on the issue',
    argsSchema: {
      type: 'object',
      required: ['artifact', 'body'],
      properties: {
        artifact: artifactArg,
        body: {
          type: 'string',
          minLength: 1,
          title: 'Body',
          description: 'Markdown comment text.',
        },
      },
    },
  },
];

const actionsById = new Map(actions.map((a) => [a.id, a]));

const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    id identifier title url updatedAt priority priorityLabel
    state { id name type }
    team { id key }
    assignee { name }
    labels { nodes { id name } }
  }
}`;

const LABELS_QUERY = `query Labels($name: String!) {
  issueLabels(filter: { name: { eqIgnoreCase: $name } }) { nodes { id name team { id } } }
}`;

const STATES_QUERY = `query States($teamId: ID!, $name: String!) {
  workflowStates(filter: { team: { id: { eq: $teamId } }, name: { eqIgnoreCase: $name } }) { nodes { id name } }
}`;

const ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}`;

const TEAMS_QUERY = `query Teams($keys: [String!]) {
  teams(filter: { key: { in: $keys } }) { nodes { id key } }
}`;

const WEBHOOK_CREATE = `mutation WebhookCreate($input: WebhookCreateInput!) {
  webhookCreate(input: $input) { success webhook { id enabled } }
}`;

function nodes(value: unknown): Json[] {
  return arr(path(value, 'nodes')).flatMap((n) => {
    const o = obj(n);
    return o ? [o] : [];
  });
}

/**
 * Linear-Signature is the hex HMAC-SHA256 of the raw body; `webhookTimestamp` (ms, in the body)
 * must be within a minute of now so a captured delivery cannot be replayed later.
 */
export function verifyDelivery(secret: string, req: RawRequest, now: Date): VerifyResult {
  const signature = req.headers['linear-signature'];
  if (signature === undefined || signature === '')
    return { ok: false, reason: 'missing linear-signature header' };
  if (!verifyHmac({ secret, payload: req.body, signature }))
    return { ok: false, reason: 'signature mismatch' };
  const timestamp = num(parseJsonObject(req.body.toString('utf8'))?.webhookTimestamp);
  if (timestamp === undefined) return { ok: false, reason: 'missing webhookTimestamp' };
  if (Math.abs(now.getTime() - timestamp) > MAX_SKEW_MS) {
    return { ok: false, reason: 'webhookTimestamp is more than 60 s from now' };
  }
  return { ok: true };
}

function createLinearSource(settings: Settings, ctx: PluginContext): Source {
  const s: LinearSettings = readSettings(settings);
  const api: LinearApi = createApi(ctx.http, s.apiKey);

  async function fetchIssue(id: string): Promise<Json | null> {
    try {
      const data = await api.graphql(ISSUE_QUERY, { id });
      return obj(data.issue) ?? null;
    } catch (err) {
      if (err instanceof LinearApiError && err.notFound) return null;
      throw err;
    }
  }

  async function withIssue(
    ref: ArtifactRef,
    run: (issue: Json) => Promise<ActionResult>,
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

  async function update(issue: Json, input: Json, message: string): Promise<ActionResult> {
    const data = await api.graphql(ISSUE_UPDATE, { id: str(issue.id) ?? '', input });
    return path(data, 'issueUpdate', 'success') === true
      ? { ok: true, message }
      : { ok: false, message: 'Linear did not apply the update' };
  }

  async function act(action: string, args: unknown): Promise<ActionResult> {
    const spec = actionsById.get(action);
    if (!spec) return { ok: false, message: `Unknown action "${action}"` };
    const check = validateAgainst(spec.argsSchema, args);
    if (!check.valid) return { ok: false, message: `Invalid args: ${check.errors.join('; ')}` };
    const a = args as { artifact: ArtifactRef; label?: string; state?: string; body?: string };
    const id = a.artifact.id;
    switch (action) {
      case 'addLabel':
        return withIssue(a.artifact, async (issue) => {
          const wanted = (a.label ?? '').toLowerCase();
          const current = nodes(issue.labels);
          if (current.some((l) => str(l.name)?.toLowerCase() === wanted)) {
            return { ok: true, message: `${id} already has label ${a.label ?? ''}` };
          }
          const teamId = str(path(issue, 'team', 'id'));
          const candidates = nodes(
            (await api.graphql(LABELS_QUERY, { name: a.label })).issueLabels,
          );
          // Prefer the issue's team label over a workspace label of the same name.
          const label =
            candidates.find((l) => str(path(l, 'team', 'id')) === teamId) ??
            candidates.find((l) => path(l, 'team') == null);
          const labelId = str(label?.id);
          if (labelId === undefined)
            return {
              ok: false,
              message: `No label named ${a.label ?? ''} in the issue's team or workspace`,
            };
          const labelIds = [...current.flatMap((l) => str(l.id) ?? []), labelId];
          return update(issue, { labelIds }, `Added label ${str(label?.name) ?? ''} to ${id}`);
        });
      case 'setState':
        return withIssue(a.artifact, async (issue) => {
          const teamId = str(path(issue, 'team', 'id')) ?? '';
          const states = nodes(
            (await api.graphql(STATES_QUERY, { teamId, name: a.state })).workflowStates,
          );
          const stateId = str(states[0]?.id);
          if (stateId === undefined)
            return {
              ok: false,
              message: `No workflow state named ${a.state ?? ''} in the issue's team`,
            };
          if (str(path(issue, 'state', 'id')) === stateId)
            return { ok: true, message: `${id} is already in ${a.state ?? ''}` };
          return update(issue, { stateId }, `Moved ${id} to ${str(states[0]?.name) ?? ''}`);
        });
      case 'comment':
        return withIssue(a.artifact, async (issue) => {
          const data = await api.graphql(COMMENT_CREATE, {
            input: { issueId: str(issue.id) ?? '', body: a.body },
          });
          const comment = obj(path(data, 'commentCreate', 'comment'));
          return path(data, 'commentCreate', 'success') === true
            ? {
                ok: true,
                message: `Commented on ${id}`,
                data: { id: str(comment?.id), url: str(comment?.url) },
              }
            : { ok: false, message: 'Linear did not create the comment' };
        });
      default:
        return { ok: false, message: `Unknown action "${action}"` };
    }
  }

  async function provision(webhookUrl: string): Promise<ProvisionResult> {
    const base = {
      url: webhookUrl,
      resourceTypes: ['Issue', 'Comment'],
      secret: s.webhookSecret,
      label: 'AI Switchboard',
    };
    let inputs: Json[] = [{ ...base, allPublicTeams: true }];
    try {
      if (s.teamKeys.length > 0) {
        const teams = nodes((await api.graphql(TEAMS_QUERY, { keys: s.teamKeys })).teams);
        const missing = s.teamKeys.filter(
          (k) => !teams.some((t) => str(t.key)?.toLowerCase() === k.toLowerCase()),
        );
        if (missing.length > 0)
          return { ok: false, message: `Unknown team keys: ${missing.join(', ')}` };
        inputs = teams.map((t) => ({ ...base, teamId: str(t.id) }));
      }
      const created: string[] = [];
      for (const input of inputs) {
        const data = await api.graphql(WEBHOOK_CREATE, { input });
        const webhookId = str(path(data, 'webhookCreate', 'webhook', 'id'));
        if (path(data, 'webhookCreate', 'success') !== true || webhookId === undefined) {
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
    if (ref.kind !== 'linear.issue') throw new Error(`linear cannot look up ${ref.kind}`);
    const issue = await fetchIssue(ref.id);
    if (!issue) return null;
    const url = str(issue.url) ?? '';
    const updatedAt = str(issue.updatedAt) ?? '';
    return {
      ref: { kind: 'linear.issue', id: str(issue.identifier) ?? ref.id, url, version: updatedAt },
      title: str(issue.title) ?? '',
      state: str(path(issue, 'state', 'name')) ?? '',
      stateType: str(path(issue, 'state', 'type')) ?? '',
      labels: nodes(issue.labels).flatMap((l) => str(l.name) ?? []),
      priority: num(issue.priority) ?? 0,
      assignee: str(path(issue, 'assignee', 'name')) ?? null,
      url,
      updatedAt,
    };
  }

  async function health(): Promise<Health> {
    try {
      const data = await api.graphql('query Viewer { viewer { id name } }');
      const name = str(path(data, 'viewer', 'name'));
      return {
        status: 'healthy',
        ...(name !== undefined ? { message: `Authenticated as ${name}` } : {}),
        checkedAt: ctx.now().toISOString(),
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
    verify: (req) => verifyDelivery(s.webhookSecret, req, ctx.now()),
    parse: (req) => parseDelivery(req, s.teamKeys),
    provision,
    resolve,
    act,
    health,
  };
}

export const linearSource: SourceType = {
  id: 'linear',
  displayName: 'Linear',
  description:
    'Linear issue and comment webhooks, with label and state changes derived per change, plus live state and actions.',
  mode: 'push',
  settingsSchema,
  eventTypes,
  actions,
  create: createLinearSource,
};
