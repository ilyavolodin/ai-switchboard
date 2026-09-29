import {
  asArray,
  asObject,
  asString,
  type ArtifactRef,
  type ActionSpec,
  type JSONSchema,
} from '@ai-switchboard/sdk';

export const NUMBERED_ID = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)#([0-9]+)$/;

export interface Numbered {
  owner: string;
  repo: string;
  number: number;
}

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

export const actionsById = new Map(actions.map((a) => [a.id, a]));
export const MARK_READY = `mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } }
}`;

export function labelNames(value: unknown): string[] {
  return asArray(value).flatMap((l) => {
    const name = asString(asObject(l)?.name);
    return name === undefined ? [] : [name];
  });
}

export function itemPath(n: Numbered, kind: string): string {
  const base = `/repos/${n.owner}/${n.repo}`;
  return kind === 'github.pr' ? `${base}/pulls/${n.number}` : `${base}/issues/${n.number}`;
}

export function numberedOrThrow(ref: ArtifactRef): Numbered {
  const n = parseNumberedId(ref.id);
  if (!n || (ref.kind !== 'github.pr' && ref.kind !== 'github.issue')) {
    throw new Error(`github cannot look up ${ref.kind} ${ref.id}; only github.pr and github.issue`);
  }
  return n;
}
