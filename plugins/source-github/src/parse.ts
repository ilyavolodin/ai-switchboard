import {
  dedupeKey,
  type ArtifactRef,
  type Attributes,
  type EventDraft,
  type RawRequest,
  asArray,
  asBoolean,
  asNumber,
  asObject,
  parseJsonObject,
  getPath,
  asString,
  type JsonObject,
} from '@ai-switchboard/sdk';

const PR_ACTIONS: Record<string, string> = {
  opened: 'github.pr.opened',
  reopened: 'github.pr.reopened',
  labeled: 'github.pr.labeled',
  unlabeled: 'github.pr.unlabeled',
  ready_for_review: 'github.pr.ready_for_review',
  synchronize: 'github.pr.synchronize',
};

const ISSUE_ACTIONS: Record<string, string> = {
  opened: 'github.issue.opened',
  closed: 'github.issue.closed',
  reopened: 'github.issue.reopened',
  labeled: 'github.issue.labeled',
  unlabeled: 'github.issue.unlabeled',
};

/** Allowlist entries are `api` or `acme/api`. */
export function repoAllowed(repo: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const full = repo.toLowerCase();
  const short = full.split('/')[1] ?? full;
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e.includes('/') ? e === full : e === short;
  });
}

function labelNames(value: unknown): string[] {
  return asArray(value).flatMap((l) => {
    const name = asString(asObject(l)?.name);
    return name === undefined ? [] : [name];
  });
}

function login(value: unknown): string {
  return asString(asObject(value)?.login) ?? '';
}

function iso(value: unknown, fallback: string): string {
  const s = asString(value);
  if (s !== undefined) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  const n = asNumber(value);
  // Push payloads carry some times as epoch seconds.
  if (n !== undefined) return new Date(n * 1000).toISOString();
  return fallback;
}

interface Draft {
  type: string;
  artifact: ArtifactRef;
  attributes: Attributes;
  occurredAt: string;
}

function finish(d: Draft, deliveryId: string | undefined): EventDraft {
  return {
    ...d,
    dedupeKey: dedupeKey(d.type, d.artifact, deliveryId),
    ...(deliveryId !== undefined ? { deliveryId } : {}),
  };
}

function prAttributes(pr: JsonObject, repo: string, action: string, sender: string): Attributes {
  return {
    repo,
    number: asNumber(pr.number) ?? 0,
    title: asString(pr.title) ?? '',
    author: login(pr.user),
    state: asString(pr.state) ?? '',
    draft: asBoolean(pr.draft) ?? false,
    merged: asBoolean(pr.merged) ?? false,
    baseRef: asString(getPath(pr, 'base', 'ref')) ?? '',
    headRef: asString(getPath(pr, 'head', 'ref')) ?? '',
    labels: labelNames(pr.labels),
    action,
    sender,
  };
}

function numberedArtifact(
  kind: string,
  repo: string,
  item: JsonObject,
  version: string | undefined,
): ArtifactRef {
  const ref: ArtifactRef = { kind, id: `${repo}#${asNumber(item.number) ?? 0}` };
  const url = asString(item.html_url);
  if (url !== undefined) ref.url = url;
  if (version !== undefined) ref.version = version;
  return ref;
}

function pullRequestEvent(
  body: JsonObject,
  repo: string,
  sender: string,
  fallback: string,
): Draft[] {
  const pr = asObject(body.pull_request);
  const action = asString(body.action) ?? '';
  if (!pr) return [];
  const updatedAt = asString(pr.updated_at);
  let type = PR_ACTIONS[action];
  if (action === 'closed')
    type = asBoolean(pr.merged) === true ? 'github.pr.merged' : 'github.pr.closed';
  if (type === undefined) return [];
  const attributes = prAttributes(pr, repo, action, sender);
  let version = updatedAt;
  if (action === 'labeled' || action === 'unlabeled') {
    const label = asString(getPath(body, 'label', 'name'));
    if (label === undefined) return [];
    attributes.label = label;
    // Two different labels in the same second must not collapse into one change.
    version = `${updatedAt ?? ''}:${label}`;
  }
  if (action === 'synchronize') {
    const after = asString(body.after) ?? asString(getPath(pr, 'head', 'sha')) ?? '';
    attributes.headSha = after;
    version = `${updatedAt ?? ''}:${after}`;
  }
  const occurredAt =
    action === 'closed'
      ? iso(pr.merged_at ?? pr.closed_at, iso(updatedAt, fallback))
      : iso(updatedAt, fallback);
  return [
    { type, artifact: numberedArtifact('github.pr', repo, pr, version), attributes, occurredAt },
  ];
}

function reviewEvent(body: JsonObject, repo: string, sender: string, fallback: string): Draft[] {
  const pr = asObject(body.pull_request);
  const review = asObject(body.review);
  if (!pr || !review || asString(body.action) !== 'submitted') return [];
  const attributes = prAttributes(pr, repo, 'submitted', sender);
  attributes.reviewState = (asString(review.state) ?? '').toLowerCase();
  attributes.reviewer = login(review.user);
  // A review is its own change: key it by the review id, not the PR's updated_at.
  const version = `review:${asNumber(review.id) ?? asString(review.node_id) ?? ''}`;
  return [
    {
      type: 'github.pr.review_submitted',
      artifact: numberedArtifact('github.pr', repo, pr, version),
      attributes,
      occurredAt: iso(review.submitted_at, fallback),
    },
  ];
}

function issueEvent(body: JsonObject, repo: string, sender: string, fallback: string): Draft[] {
  const issue = asObject(body.issue);
  const action = asString(body.action) ?? '';
  const type = ISSUE_ACTIONS[action];
  if (!issue || type === undefined) return [];
  const updatedAt = asString(issue.updated_at);
  const attributes: Attributes = {
    repo,
    number: asNumber(issue.number) ?? 0,
    title: asString(issue.title) ?? '',
    author: login(issue.user),
    state: asString(issue.state) ?? '',
    labels: labelNames(issue.labels),
    action,
    sender,
  };
  let version = updatedAt;
  if (action === 'labeled' || action === 'unlabeled') {
    const label = asString(getPath(body, 'label', 'name'));
    if (label === undefined) return [];
    attributes.label = label;
    version = `${updatedAt ?? ''}:${label}`;
  }
  return [
    {
      type,
      artifact: numberedArtifact('github.issue', repo, issue, version),
      attributes,
      occurredAt: iso(updatedAt, fallback),
    },
  ];
}

function checkSuiteEvent(
  body: JsonObject,
  repo: string,
  sender: string,
  fallback: string,
): Draft[] {
  const suite = asObject(body.check_suite);
  if (!suite || asString(body.action) !== 'completed') return [];
  const id = asNumber(suite.id) ?? asString(suite.node_id) ?? '';
  const attributes: Attributes = {
    repo,
    action: 'completed',
    sender,
    status: asString(suite.status) ?? 'completed',
    conclusion: asString(suite.conclusion) ?? '',
    headSha: asString(suite.head_sha) ?? '',
    app: asString(getPath(suite, 'app', 'slug')) ?? '',
    pullRequests: asArray(suite.pull_requests).flatMap((p) => {
      const n = asNumber(asObject(p)?.number);
      return n === undefined ? [] : [`${repo}#${n}`];
    }),
  };
  const headBranch = asString(suite.head_branch);
  if (headBranch !== undefined) attributes.headBranch = headBranch;
  const artifact: ArtifactRef = { kind: 'github.check_suite', id: `${repo}/check-suites/${id}` };
  const updatedAt = asString(suite.updated_at);
  if (updatedAt !== undefined) artifact.version = updatedAt;
  return [
    {
      type: 'github.check_suite.completed',
      artifact,
      attributes,
      occurredAt: iso(updatedAt, fallback),
    },
  ];
}

function releaseEvent(body: JsonObject, repo: string, sender: string, fallback: string): Draft[] {
  const release = asObject(body.release);
  if (!release || asString(body.action) !== 'published') return [];
  const tag = asString(release.tag_name) ?? '';
  const artifact: ArtifactRef = { kind: 'github.release', id: `${repo}@${tag}` };
  const url = asString(release.html_url);
  if (url !== undefined) artifact.url = url;
  const publishedAt = asString(release.published_at);
  if (publishedAt !== undefined) artifact.version = publishedAt;
  return [
    {
      type: 'github.release.published',
      artifact,
      attributes: {
        repo,
        action: 'published',
        sender,
        tag,
        name: asString(release.name) ?? tag,
        prerelease: asBoolean(release.prerelease) ?? false,
        draft: asBoolean(release.draft) ?? false,
        author: login(release.author),
      },
      occurredAt: iso(publishedAt, fallback),
    },
  ];
}

function pushEvent(body: JsonObject, repo: string, sender: string, fallback: string): Draft[] {
  const ref = asString(body.ref) ?? '';
  const after = asString(body.after) ?? '';
  const headCommit = asObject(body.head_commit);
  const artifact: ArtifactRef = {
    kind: 'github.push',
    id: `${repo}:${ref}`,
    // The head commit identifies the change; a branch deletion has none, so `after` stands in.
    version: asString(headCommit?.id) ?? after,
  };
  const compare = asString(body.compare);
  if (compare !== undefined) artifact.url = compare;
  return [
    {
      type: 'github.push',
      artifact,
      attributes: {
        repo,
        action: 'push',
        sender,
        ref,
        branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '',
        tag: ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : '',
        before: asString(body.before) ?? '',
        after,
        commits: asArray(body.commits).length,
        forced: asBoolean(body.forced) ?? false,
        created: asBoolean(body.created) ?? false,
        deleted: asBoolean(body.deleted) ?? false,
        pusher: asString(getPath(body, 'pusher', 'name')) ?? '',
      },
      occurredAt: iso(headCommit?.timestamp, fallback),
    },
  ];
}

/** Unknown events and actions (and `ping`) yield no events. */
export function parseDelivery(req: RawRequest, allowlist: string[]): EventDraft[] {
  const event = req.headers['x-github-event'];
  const deliveryId = req.headers['x-github-delivery'];
  const body = parseJsonObject(req.body.toString('utf8'));
  if (!body || event === undefined || event === 'ping') return [];
  const repo = asString(getPath(body, 'repository', 'full_name'));
  if (repo === undefined || !repoAllowed(repo, allowlist)) return [];
  const sender = login(body.sender);
  const fallback = req.receivedAt;
  let drafts: Draft[];
  switch (event) {
    case 'pull_request':
      drafts = pullRequestEvent(body, repo, sender, fallback);
      break;
    case 'pull_request_review':
      drafts = reviewEvent(body, repo, sender, fallback);
      break;
    case 'issues':
      drafts = issueEvent(body, repo, sender, fallback);
      break;
    case 'check_suite':
      drafts = checkSuiteEvent(body, repo, sender, fallback);
      break;
    case 'release':
      drafts = releaseEvent(body, repo, sender, fallback);
      break;
    case 'push':
      drafts = pushEvent(body, repo, sender, fallback);
      break;
    default:
      drafts = [];
  }
  return drafts.map((d) => finish(d, deliveryId === '' ? undefined : deliveryId));
}
