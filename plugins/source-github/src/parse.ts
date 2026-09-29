import {
  dedupeKey,
  type ArtifactRef,
  type Attributes,
  type EventDraft,
  type RawRequest,
} from '@ai-switchboard/sdk';

import { arr, bool, num, obj, parseJsonObject, path, str, type Json } from './json.js';

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
  return arr(value).flatMap((l) => {
    const name = str(obj(l)?.name);
    return name === undefined ? [] : [name];
  });
}

function login(value: unknown): string {
  return str(obj(value)?.login) ?? '';
}

function iso(value: unknown, fallback: string): string {
  const s = str(value);
  if (s !== undefined) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  const n = num(value);
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

function prAttributes(pr: Json, repo: string, action: string, sender: string): Attributes {
  return {
    repo,
    number: num(pr.number) ?? 0,
    title: str(pr.title) ?? '',
    author: login(pr.user),
    state: str(pr.state) ?? '',
    draft: bool(pr.draft) ?? false,
    merged: bool(pr.merged) ?? false,
    baseRef: str(path(pr, 'base', 'ref')) ?? '',
    headRef: str(path(pr, 'head', 'ref')) ?? '',
    labels: labelNames(pr.labels),
    action,
    sender,
  };
}

function numberedArtifact(
  kind: string,
  repo: string,
  item: Json,
  version: string | undefined,
): ArtifactRef {
  const ref: ArtifactRef = { kind, id: `${repo}#${num(item.number) ?? 0}` };
  const url = str(item.html_url);
  if (url !== undefined) ref.url = url;
  if (version !== undefined) ref.version = version;
  return ref;
}

function pullRequestEvent(body: Json, repo: string, sender: string, fallback: string): Draft[] {
  const pr = obj(body.pull_request);
  const action = str(body.action) ?? '';
  if (!pr) return [];
  const updatedAt = str(pr.updated_at);
  let type = PR_ACTIONS[action];
  if (action === 'closed')
    type = bool(pr.merged) === true ? 'github.pr.merged' : 'github.pr.closed';
  if (type === undefined) return [];
  const attributes = prAttributes(pr, repo, action, sender);
  let version = updatedAt;
  if (action === 'labeled' || action === 'unlabeled') {
    const label = str(path(body, 'label', 'name'));
    if (label === undefined) return [];
    attributes.label = label;
    // Two different labels in the same second must not collapse into one change.
    version = `${updatedAt ?? ''}:${label}`;
  }
  if (action === 'synchronize') {
    const after = str(body.after) ?? str(path(pr, 'head', 'sha')) ?? '';
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

function reviewEvent(body: Json, repo: string, sender: string, fallback: string): Draft[] {
  const pr = obj(body.pull_request);
  const review = obj(body.review);
  if (!pr || !review || str(body.action) !== 'submitted') return [];
  const attributes = prAttributes(pr, repo, 'submitted', sender);
  attributes.reviewState = (str(review.state) ?? '').toLowerCase();
  attributes.reviewer = login(review.user);
  // A review is its own change: key it by the review id, not the PR's updated_at.
  const version = `review:${num(review.id) ?? str(review.node_id) ?? ''}`;
  return [
    {
      type: 'github.pr.review_submitted',
      artifact: numberedArtifact('github.pr', repo, pr, version),
      attributes,
      occurredAt: iso(review.submitted_at, fallback),
    },
  ];
}

function issueEvent(body: Json, repo: string, sender: string, fallback: string): Draft[] {
  const issue = obj(body.issue);
  const action = str(body.action) ?? '';
  const type = ISSUE_ACTIONS[action];
  if (!issue || type === undefined) return [];
  const updatedAt = str(issue.updated_at);
  const attributes: Attributes = {
    repo,
    number: num(issue.number) ?? 0,
    title: str(issue.title) ?? '',
    author: login(issue.user),
    state: str(issue.state) ?? '',
    labels: labelNames(issue.labels),
    action,
    sender,
  };
  let version = updatedAt;
  if (action === 'labeled' || action === 'unlabeled') {
    const label = str(path(body, 'label', 'name'));
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

function checkSuiteEvent(body: Json, repo: string, sender: string, fallback: string): Draft[] {
  const suite = obj(body.check_suite);
  if (!suite || str(body.action) !== 'completed') return [];
  const id = num(suite.id) ?? str(suite.node_id) ?? '';
  const attributes: Attributes = {
    repo,
    action: 'completed',
    sender,
    status: str(suite.status) ?? 'completed',
    conclusion: str(suite.conclusion) ?? '',
    headSha: str(suite.head_sha) ?? '',
    app: str(path(suite, 'app', 'slug')) ?? '',
    pullRequests: arr(suite.pull_requests).flatMap((p) => {
      const n = num(obj(p)?.number);
      return n === undefined ? [] : [`${repo}#${n}`];
    }),
  };
  const headBranch = str(suite.head_branch);
  if (headBranch !== undefined) attributes.headBranch = headBranch;
  const artifact: ArtifactRef = { kind: 'github.check_suite', id: `${repo}/check-suites/${id}` };
  const updatedAt = str(suite.updated_at);
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

function releaseEvent(body: Json, repo: string, sender: string, fallback: string): Draft[] {
  const release = obj(body.release);
  if (!release || str(body.action) !== 'published') return [];
  const tag = str(release.tag_name) ?? '';
  const artifact: ArtifactRef = { kind: 'github.release', id: `${repo}@${tag}` };
  const url = str(release.html_url);
  if (url !== undefined) artifact.url = url;
  const publishedAt = str(release.published_at);
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
        name: str(release.name) ?? tag,
        prerelease: bool(release.prerelease) ?? false,
        draft: bool(release.draft) ?? false,
        author: login(release.author),
      },
      occurredAt: iso(publishedAt, fallback),
    },
  ];
}

function pushEvent(body: Json, repo: string, sender: string, fallback: string): Draft[] {
  const ref = str(body.ref) ?? '';
  const after = str(body.after) ?? '';
  const headCommit = obj(body.head_commit);
  const artifact: ArtifactRef = {
    kind: 'github.push',
    id: `${repo}:${ref}`,
    // The head commit identifies the change; a branch deletion has none, so `after` stands in.
    version: str(headCommit?.id) ?? after,
  };
  const compare = str(body.compare);
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
        before: str(body.before) ?? '',
        after,
        commits: arr(body.commits).length,
        forced: bool(body.forced) ?? false,
        created: bool(body.created) ?? false,
        deleted: bool(body.deleted) ?? false,
        pusher: str(path(body, 'pusher', 'name')) ?? '',
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
  const repo = str(path(body, 'repository', 'full_name'));
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
