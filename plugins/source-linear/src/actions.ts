import type { ActionSpec, JSONSchema } from '@ai-switchboard/sdk';

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
    // Repeating it leaves the same state, so a step in doubt may run again.
    idempotent: true,
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
    // Repeating it leaves the same state, so a step in doubt may run again.
    idempotent: true,
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

export const actionsById = new Map(actions.map((a) => [a.id, a]));

export const LABELS_QUERY = `query Labels($name: String!) {
  issueLabels(filter: { name: { eqIgnoreCase: $name } }) { nodes { id name team { id } } }
}`;

export const STATES_QUERY = `query States($teamId: ID!, $name: String!) {
  workflowStates(filter: { team: { id: { eq: $teamId } }, name: { eqIgnoreCase: $name } }) { nodes { id name } }
}`;

export const ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

export const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}`;
