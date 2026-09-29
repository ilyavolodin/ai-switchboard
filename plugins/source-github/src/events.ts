import type { Attributes, EventTypeSpec, JSONSchema } from '@ai-switchboard/sdk';

const S = (description: string): JSONSchema => ({ type: 'string', description });
const I = (description: string): JSONSchema => ({ type: 'integer', description });
const B = (description: string): JSONSchema => ({ type: 'boolean', description });
const L = (description: string): JSONSchema => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

function schema(properties: Record<string, JSONSchema>, required: string[]): JSONSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const common = {
  repo: S('Repository full name, e.g. `acme/api`.'),
  action: S('The webhook `action` (or the event name when there is none).'),
  sender: S('Login of the user or app that caused the event.'),
};

const prProps = {
  ...common,
  number: I('Pull request number.'),
  title: S('Pull request title.'),
  author: S('Login of the pull request author.'),
  state: S('`open` or `closed`.'),
  draft: B('Whether the pull request is a draft.'),
  merged: B('Whether the pull request is merged.'),
  baseRef: S('Base branch name.'),
  headRef: S('Head branch name.'),
  labels: L('Label names on the pull request.'),
};
const prRequired = Object.keys(prProps);

const issueProps = {
  ...common,
  number: I('Issue number.'),
  title: S('Issue title.'),
  author: S('Login of the issue author.'),
  state: S('`open` or `closed`.'),
  labels: L('Label names on the issue.'),
};
const issueRequired = Object.keys(issueProps);

const prExample: Attributes = {
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
};

const issueExample: Attributes = {
  repo: 'acme/api',
  number: 12,
  title: 'Webhook retries hammer the queue',
  author: 'hubot',
  state: 'open',
  labels: ['bug'],
  action: 'opened',
  sender: 'hubot',
};

function pr(verb: string, title: string, description: string, example: Attributes): EventTypeSpec {
  return {
    type: `github.pr.${verb}`,
    title,
    description,
    attributes: schema(prProps, prRequired),
    examples: [{ ...prExample, ...example }],
  };
}

function prLabel(verb: 'labeled' | 'unlabeled', title: string): EventTypeSpec {
  return {
    type: `github.pr.${verb}`,
    title,
    description: `A label was ${verb === 'labeled' ? 'added to' : 'removed from'} a pull request. \`label\` is the label that changed.`,
    attributes: schema({ ...prProps, label: S('The label that changed.') }, [
      ...prRequired,
      'label',
    ]),
    examples: [
      {
        ...prExample,
        action: verb,
        label: 'needs-review',
        labels: verb === 'labeled' ? ['backend', 'needs-review'] : ['backend'],
      },
    ],
  };
}

function issue(
  verb: string,
  title: string,
  description: string,
  example: Attributes,
): EventTypeSpec {
  return {
    type: `github.issue.${verb}`,
    title,
    description,
    attributes: schema(issueProps, issueRequired),
    examples: [{ ...issueExample, ...example }],
  };
}

function issueLabel(verb: 'labeled' | 'unlabeled', title: string): EventTypeSpec {
  return {
    type: `github.issue.${verb}`,
    title,
    description: `A label was ${verb === 'labeled' ? 'added to' : 'removed from'} an issue. \`label\` is the label that changed.`,
    attributes: schema({ ...issueProps, label: S('The label that changed.') }, [
      ...issueRequired,
      'label',
    ]),
    examples: [
      {
        ...issueExample,
        action: verb,
        label: 'triage',
        labels: verb === 'labeled' ? ['bug', 'triage'] : ['bug'],
      },
    ],
  };
}

export const eventTypes: EventTypeSpec[] = [
  pr('opened', 'Pull request opened', 'A pull request was opened.', {}),
  pr('closed', 'Pull request closed', 'A pull request was closed without being merged.', {
    action: 'closed',
    state: 'closed',
  }),
  pr(
    'merged',
    'Pull request merged',
    'A pull request was merged (GitHub sends `closed` with `merged: true`).',
    {
      action: 'closed',
      state: 'closed',
      merged: true,
    },
  ),
  pr('reopened', 'Pull request reopened', 'A closed pull request was reopened.', {
    action: 'reopened',
  }),
  prLabel('labeled', 'Pull request labeled'),
  prLabel('unlabeled', 'Pull request unlabeled'),
  pr(
    'ready_for_review',
    'Pull request ready for review',
    'A draft pull request was marked ready for review.',
    {
      action: 'ready_for_review',
    },
  ),
  {
    type: 'github.pr.synchronize',
    title: 'Pull request updated with commits',
    description: 'New commits were pushed to the pull request’s head branch.',
    attributes: schema({ ...prProps, headSha: S('The new head commit SHA.') }, [
      ...prRequired,
      'headSha',
    ]),
    examples: [
      { ...prExample, action: 'synchronize', headSha: '6dcb09b5b57875f334f61aebed695e2e4193db5e' },
    ],
  },
  {
    type: 'github.pr.review_submitted',
    title: 'Pull request review submitted',
    description: 'A review was submitted on a pull request.',
    attributes: schema(
      {
        ...prProps,
        reviewState: S('`approved`, `changes_requested` or `commented`.'),
        reviewer: S('Login of the reviewer.'),
      },
      [...prRequired, 'reviewState', 'reviewer'],
    ),
    examples: [
      {
        ...prExample,
        action: 'submitted',
        reviewState: 'approved',
        reviewer: 'monalisa',
        sender: 'monalisa',
      },
    ],
  },
  issue('opened', 'Issue opened', 'An issue was opened.', {}),
  issue('closed', 'Issue closed', 'An issue was closed.', { action: 'closed', state: 'closed' }),
  issue('reopened', 'Issue reopened', 'A closed issue was reopened.', { action: 'reopened' }),
  issueLabel('labeled', 'Issue labeled'),
  issueLabel('unlabeled', 'Issue unlabeled'),
  {
    type: 'github.check_suite.completed',
    title: 'Check suite completed',
    description: 'All check runs in a check suite finished.',
    attributes: schema(
      {
        ...common,
        status: S('Check suite status (`completed`).'),
        conclusion: S(
          '`success`, `failure`, `neutral`, `cancelled`, `timed_out`, `action_required` or `stale`.',
        ),
        headBranch: S('Branch the suite ran on.'),
        headSha: S('Commit the suite ran on.'),
        app: S('Slug of the app that owns the suite, e.g. `github-actions`.'),
        pullRequests: L('Pull requests the suite belongs to, as `acme/api#482`.'),
      },
      ['repo', 'action', 'sender', 'status', 'conclusion', 'headSha', 'app', 'pullRequests'],
    ),
    examples: [
      {
        repo: 'acme/api',
        action: 'completed',
        sender: 'github-actions[bot]',
        status: 'completed',
        conclusion: 'failure',
        headBranch: 'feat/retry-backoff',
        headSha: '6dcb09b5b57875f334f61aebed695e2e4193db5e',
        app: 'github-actions',
        pullRequests: ['acme/api#482'],
      },
    ],
  },
  {
    type: 'github.release.published',
    title: 'Release published',
    description: 'A release was published.',
    attributes: schema(
      {
        ...common,
        tag: S('The release tag.'),
        name: S('The release title.'),
        prerelease: B('Whether it is a pre-release.'),
        draft: B('Whether it is a draft.'),
        author: S('Login of the release author.'),
      },
      ['repo', 'action', 'sender', 'tag', 'name', 'prerelease', 'draft', 'author'],
    ),
    examples: [
      {
        repo: 'acme/api',
        action: 'published',
        sender: 'octocat',
        tag: 'v2.14.0',
        name: 'v2.14.0',
        prerelease: false,
        draft: false,
        author: 'octocat',
      },
    ],
  },
  {
    type: 'github.push',
    title: 'Push',
    description:
      'Commits (or a branch or tag) were pushed. There is no `.verb`: GitHub’s push has one kind.',
    attributes: schema(
      {
        ...common,
        ref: S('Full ref, e.g. `refs/heads/main`.'),
        branch: S('Branch name, or empty for a tag push.'),
        tag: S('Tag name, or empty for a branch push.'),
        before: S('SHA before the push.'),
        after: S('SHA after the push.'),
        commits: I('Number of commits in the push.'),
        forced: B('Whether it was a force push.'),
        created: B('Whether the push created the ref.'),
        deleted: B('Whether the push deleted the ref.'),
        pusher: S('Name of the pusher.'),
      },
      [
        'repo',
        'action',
        'sender',
        'ref',
        'branch',
        'tag',
        'before',
        'after',
        'commits',
        'forced',
        'created',
        'deleted',
        'pusher',
      ],
    ),
    examples: [
      {
        repo: 'acme/api',
        action: 'push',
        sender: 'octocat',
        ref: 'refs/heads/main',
        branch: 'main',
        tag: '',
        before: '9049f1265b7d61be4a8904a9a27120d2064dab3b',
        after: '0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c',
        commits: 2,
        forced: false,
        created: false,
        deleted: false,
        pusher: 'octocat',
      },
    ],
  },
];

export const WEBHOOK_EVENTS = [
  'pull_request',
  'pull_request_review',
  'issues',
  'check_suite',
  'release',
  'push',
] as const;
