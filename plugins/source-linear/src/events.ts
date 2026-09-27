import type { Attributes, EventTypeSpec, JSONSchema } from '@ai-switchboard/sdk';

const S = (description: string): JSONSchema => ({ type: 'string', description });
const L = (description: string): JSONSchema => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

function schema(properties: Record<string, JSONSchema>, required: string[]): JSONSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const issueProps = {
  team: S('Team key, e.g. `LOL`.'),
  identifier: S('Issue identifier, e.g. `LOL-1712`.'),
  title: S('Issue title.'),
  state: S('Workflow state name, e.g. `In Progress`.'),
  stateType: S(
    'Workflow state type: `triage`, `backlog`, `unstarted`, `started`, `completed` or `canceled`.',
  ),
  priority: {
    type: 'integer',
    minimum: 0,
    maximum: 4,
    description: '0 none, 1 urgent, 2 high, 3 medium, 4 low.',
  },
  priorityLabel: S('Priority name, e.g. `High`.'),
  labels: L('Label names currently on the issue.'),
  assignee: S('Assignee display name.'),
  actor: S('Name of the user or app that made the change.'),
};
const required = ['team', 'identifier', 'title', 'labels', 'actor'];

const example: Attributes = {
  team: 'LOL',
  identifier: 'LOL-1712',
  title: 'Retry webhook deliveries with backoff',
  state: 'In Progress',
  stateType: 'started',
  priority: 2,
  priorityLabel: 'High',
  labels: ['backend', 'agent-ready'],
  assignee: 'Ilya Volodin',
  actor: 'Ilya Volodin',
};

function label(verb: 'labeled' | 'unlabeled'): EventTypeSpec {
  return {
    type: `linear.issue.${verb}`,
    title: verb === 'labeled' ? 'Issue labeled' : 'Issue unlabeled',
    description: `A label was ${verb === 'labeled' ? 'added to' : 'removed from'} an issue; one event per label. \`label\` is its name when Linear includes it, otherwise its id.`,
    attributes: schema(
      {
        ...issueProps,
        label: S('The label that changed (name, or id when the name is unknown).'),
        labelId: S('The label’s id.'),
      },
      [...required, 'label', 'labelId'],
    ),
    examples: [
      verb === 'labeled'
        ? { ...example, label: 'agent-ready', labelId: '3f0b8a52-8a7e-4d3c-9d7e-1f2a3b4c5d6e' }
        : {
            ...example,
            labels: ['backend'],
            label: 'agent-ready',
            labelId: '3f0b8a52-8a7e-4d3c-9d7e-1f2a3b4c5d6e',
          },
    ],
  };
}

export const eventTypes: EventTypeSpec[] = [
  {
    type: 'linear.issue.created',
    title: 'Issue created',
    description: 'An issue was created.',
    attributes: schema(issueProps, required),
    examples: [{ ...example, state: 'Todo', stateType: 'unstarted', labels: ['backend'] }],
  },
  label('labeled'),
  label('unlabeled'),
  {
    type: 'linear.issue.state_changed',
    title: 'Issue state changed',
    description:
      'An issue moved to another workflow state. `toState` is the new state’s name; Linear sends only the previous state’s id, so `fromState` is present only when the payload names it.',
    attributes: schema(
      {
        ...issueProps,
        fromStateId: S('Id of the previous workflow state.'),
        fromState: S('Name of the previous workflow state, when known.'),
        toState: S('Name of the new workflow state.'),
        toStateId: S('Id of the new workflow state.'),
      },
      [...required, 'fromStateId', 'toState', 'toStateId'],
    ),
    examples: [
      {
        ...example,
        fromStateId: '6a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b',
        toState: 'In Progress',
        toStateId: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
      },
    ],
  },
  {
    type: 'linear.issue.updated',
    title: 'Issue updated',
    description:
      'An issue changed in some other way (title, priority, assignee, estimate, …). `changedFields` names what changed. Label and state changes have their own event types.',
    attributes: schema(
      {
        ...issueProps,
        changedFields: L('Fields Linear reported as changed, e.g. `priority`, `assigneeId`.'),
      },
      [...required, 'changedFields'],
    ),
    examples: [{ ...example, changedFields: ['priority'] }],
  },
  {
    type: 'linear.comment.created',
    title: 'Comment created',
    description:
      'A comment was added to an issue. The artifact is the issue; the comment text is not an attribute.',
    attributes: schema(
      {
        team: issueProps.team,
        identifier: issueProps.identifier,
        title: issueProps.title,
        actor: S('Name of the comment author.'),
        commentId: S('The comment’s id.'),
      },
      ['identifier', 'actor', 'commentId'],
    ),
    examples: [
      {
        team: 'LOL',
        identifier: 'LOL-1712',
        title: 'Retry webhook deliveries with backoff',
        actor: 'Ilya Volodin',
        commentId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
      },
    ],
  },
];
