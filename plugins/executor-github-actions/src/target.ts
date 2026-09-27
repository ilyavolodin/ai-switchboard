import { InvokeError, type JSONSchema, SchemaMismatchError, parseWith } from '@ai-switchboard/sdk';

/** Which workflow a process dispatches. */
export interface WorkflowTarget {
  owner: string;
  repo: string;
  /** Workflow file name (`triage.yml`) or numeric id. */
  workflow: string | number;
  /** Branch or tag the workflow runs on. */
  ref: string;
}

/** `workflow_dispatch` inputs; `switchboard_run_id` is added by the executor. */
export type WorkflowInputs = Record<string, string>;

export const RUN_ID_INPUT = 'switchboard_run_id';

const NAME = '^[A-Za-z0-9_.-]+$';

export const targetSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'Workflow',
  description: 'The workflow_dispatch workflow to run.',
  required: ['owner', 'repo', 'workflow'],
  additionalProperties: false,
  properties: {
    owner: {
      type: 'string',
      pattern: NAME,
      title: 'Owner',
      description: 'Organization or user that owns the repository.',
    },
    repo: { type: 'string', pattern: NAME, title: 'Repository', description: 'Repository name.' },
    workflow: {
      type: ['string', 'integer'],
      pattern: NAME,
      title: 'Workflow',
      description: 'Workflow file name (e.g. `triage.yml`) or numeric workflow id.',
      'x-placeholder': 'triage.yml',
    },
    ref: {
      type: 'string',
      minLength: 1,
      default: 'main',
      title: 'Ref',
      description: 'Branch or tag to run the workflow on.',
    },
  },
};

export const inputSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'Workflow inputs',
  description:
    'The workflow_dispatch inputs, as strings. The executor adds `switchboard_run_id`; the workflow must declare it.',
  additionalProperties: { type: 'string' },
  propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_-]*$' },
};

function definitive<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SchemaMismatchError) {
      throw new InvokeError(err.message, { definitive: true });
    }
    throw err;
  }
}

export function readTarget(target: unknown): WorkflowTarget {
  return definitive(() => parseWith<WorkflowTarget>(targetSchema, target, 'workflow target'));
}

export function readInputs(input: unknown): WorkflowInputs {
  return definitive(() => parseWith<WorkflowInputs>(inputSchema, input ?? {}, 'workflow inputs'));
}
