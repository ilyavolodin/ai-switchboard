import {
  dedupeKey,
  type ArtifactRef,
  type Attributes,
  type EventDraft,
  type RawRequest,
  asArray,
  asNumber,
  asObject,
  parseJsonObject,
  getPath,
  asString,
  type JsonObject,
} from '@ai-switchboard/sdk';

/** `updatedFrom` keys that are bookkeeping, not a change a person would filter on. */
const BOOKKEEPING = new Set([
  'updatedAt',
  'sortOrder',
  'subIssueSortOrder',
  'prioritySortOrder',
  'boardOrder',
]);
/** Keys with their own event types (or derived from those). */
const DEDICATED = new Set([
  'labelIds',
  'stateId',
  'state',
  'labels',
  'startedAt',
  'completedAt',
  'canceledAt',
  'startedTriageAt',
  'triagedAt',
]);

function strings(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === 'string');
}

function iso(value: unknown): string | undefined {
  const s = asString(value);
  if (s === undefined) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Team key from the payload, or the identifier's prefix (`LOL-1712` → `LOL`). */
export function teamKey(data: JsonObject): string | undefined {
  const key = asString(getPath(data, 'team', 'key'));
  if (key !== undefined) return key;
  const identifier = asString(data.identifier);
  const dash = identifier?.lastIndexOf('-') ?? -1;
  return identifier !== undefined && dash > 0 ? identifier.slice(0, dash) : undefined;
}

function teamAllowed(key: string | undefined, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  if (key === undefined) return false;
  return allowlist.some((k) => k.toLowerCase() === key.toLowerCase());
}

function actorName(body: JsonObject): string {
  return (
    asString(getPath(body, 'actor', 'name')) ??
    asString(getPath(body, 'data', 'user', 'name')) ??
    ''
  );
}

function issueAttributes(data: JsonObject, actor: string): Attributes {
  const attrs: Attributes = {
    team: teamKey(data) ?? '',
    identifier: asString(data.identifier) ?? '',
    title: asString(data.title) ?? '',
    labels: asArray(data.labels).flatMap((l) => {
      const name = asString(asObject(l)?.name);
      return name === undefined ? [] : [name];
    }),
    actor,
  };
  const state = asString(getPath(data, 'state', 'name'));
  if (state !== undefined) attrs.state = state;
  const stateType = asString(getPath(data, 'state', 'type'));
  if (stateType !== undefined) attrs.stateType = stateType;
  const priority = asNumber(data.priority);
  if (priority !== undefined && Number.isInteger(priority)) attrs.priority = priority;
  const priorityLabel = asString(data.priorityLabel);
  if (priorityLabel !== undefined) attrs.priorityLabel = priorityLabel;
  const assignee = asString(getPath(data, 'assignee', 'name'));
  if (assignee !== undefined) attrs.assignee = assignee;
  return attrs;
}

function issueArtifact(data: JsonObject, version: string | undefined): ArtifactRef | undefined {
  const identifier = asString(data.identifier);
  if (identifier === undefined || identifier === '') return undefined;
  const ref: ArtifactRef = { kind: 'linear.issue', id: identifier };
  const url = asString(data.url);
  if (url !== undefined) ref.url = url;
  if (version !== undefined && version !== '') ref.version = version;
  return ref;
}

interface Draft {
  type: string;
  artifact: ArtifactRef;
  attributes: Attributes;
  occurredAt: string;
}

function issueEvents(body: JsonObject, data: JsonObject, fallback: string): Draft[] {
  const action = asString(body.action);
  const actor = actorName(body);
  const updatedAt = asString(data.updatedAt);
  const base = issueAttributes(data, actor);

  if (action === 'create') {
    const artifact = issueArtifact(data, updatedAt);
    if (!artifact) return [];
    const occurredAt = iso(data.createdAt) ?? iso(updatedAt) ?? fallback;
    return [{ type: 'linear.issue.created', artifact, attributes: base, occurredAt }];
  }
  if (action !== 'update') return [];

  const from = asObject(body.updatedFrom) ?? {};
  const occurredAt = iso(updatedAt) ?? iso(body.createdAt) ?? fallback;
  const drafts: Draft[] = [];

  if (Array.isArray(from.labelIds)) {
    const before = new Set(strings(from.labelIds));
    const after = strings(data.labelIds);
    const afterSet = new Set(after);
    const names = new Map(
      asArray(data.labels).flatMap((l) => {
        const o = asObject(l);
        const id = asString(o?.id);
        const name = asString(o?.name);
        return id !== undefined && name !== undefined ? [[id, name] as const] : [];
      }),
    );
    const changes: [string, 'linear.issue.labeled' | 'linear.issue.unlabeled'][] = [
      ...after
        .filter((id) => !before.has(id))
        .map((id) => [id, 'linear.issue.labeled'] as [string, 'linear.issue.labeled']),
      ...[...before]
        .filter((id) => !afterSet.has(id))
        .map((id) => [id, 'linear.issue.unlabeled'] as [string, 'linear.issue.unlabeled']),
    ];
    for (const [labelId, type] of changes) {
      // One event per label; the label id in the version keeps two labels in one update apart.
      const artifact = issueArtifact(data, `${updatedAt ?? ''}:${labelId}`);
      if (!artifact) continue;
      drafts.push({
        type,
        artifact,
        attributes: { ...base, label: names.get(labelId) ?? labelId, labelId },
        occurredAt,
      });
    }
  }

  const fromStateId = asString(from.stateId);
  if (fromStateId !== undefined) {
    const artifact = issueArtifact(data, updatedAt);
    if (artifact) {
      const attributes: Attributes = {
        ...base,
        fromStateId,
        toState: asString(getPath(data, 'state', 'name')) ?? '',
        toStateId: asString(data.stateId) ?? asString(getPath(data, 'state', 'id')) ?? '',
      };
      const fromState = asString(getPath(from, 'state', 'name'));
      if (fromState !== undefined) attributes.fromState = fromState;
      drafts.push({ type: 'linear.issue.state_changed', artifact, attributes, occurredAt });
    }
  }

  const changedFields = Object.keys(from)
    .filter((k) => !BOOKKEEPING.has(k) && !DEDICATED.has(k))
    .sort();
  const onlyBookkeeping = Object.keys(from).every((k) => BOOKKEEPING.has(k));
  if (changedFields.length > 0 || (drafts.length === 0 && onlyBookkeeping)) {
    const artifact = issueArtifact(data, updatedAt);
    if (artifact) {
      drafts.push({
        type: 'linear.issue.updated',
        artifact,
        attributes: { ...base, changedFields },
        occurredAt,
      });
    }
  }
  return drafts;
}

function commentEvents(body: JsonObject, data: JsonObject, fallback: string): Draft[] {
  if (asString(body.action) !== 'create') return [];
  const issue = asObject(data.issue) ?? {};
  const commentId = asString(data.id);
  // Linear names the issue by identifier when it includes one; the issue id also resolves.
  const identifier = asString(issue.identifier) ?? asString(issue.id) ?? asString(data.issueId);
  if (commentId === undefined || identifier === undefined) return [];
  const artifact: ArtifactRef = {
    kind: 'linear.issue',
    id: identifier,
    version: `comment:${commentId}`,
  };
  const url = asString(issue.url);
  if (url !== undefined) artifact.url = url;
  const attributes: Attributes = { identifier, actor: actorName(body), commentId };
  const team = teamKey(issue);
  if (team !== undefined) attributes.team = team;
  const title = asString(issue.title);
  if (title !== undefined) attributes.title = title;
  return [
    {
      type: 'linear.comment.created',
      artifact,
      attributes,
      occurredAt: iso(data.createdAt) ?? iso(body.createdAt) ?? fallback,
    },
  ];
}

export function parseDelivery(req: RawRequest, teamKeys: string[]): EventDraft[] {
  const body = parseJsonObject(req.body.toString('utf8'));
  const data = asObject(body?.data);
  if (!body || !data) return [];
  const type = asString(body.type);
  const scope = type === 'Comment' ? (asObject(data.issue) ?? {}) : data;
  if (!teamAllowed(teamKey(scope), teamKeys)) return [];
  const header = req.headers['linear-delivery'];
  const deliveryId = header === undefined || header === '' ? undefined : header;
  let drafts: Draft[] = [];
  if (type === 'Issue') drafts = issueEvents(body, data, req.receivedAt);
  else if (type === 'Comment') drafts = commentEvents(body, data, req.receivedAt);
  return drafts.map((d) => ({
    ...d,
    dedupeKey: dedupeKey(d.type, d.artifact, deliveryId),
    ...(deliveryId !== undefined ? { deliveryId } : {}),
  }));
}
