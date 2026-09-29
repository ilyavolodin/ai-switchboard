/**
 * What each kind of expression can read, for editors and suggestions. Browser-safe: no runtime
 * imports. `context-descriptors.test.ts` keeps these in step with the context builders.
 */

export type ContextFieldType =
  'string' | 'number' | 'boolean' | 'datetime' | 'object' | 'array' | 'any';

export interface ContextField {
  name: string;
  type: ContextFieldType;
  description: string;
  /** Absent from some values (a field set only in some runs or events). */
  optional?: boolean;
  /** The fields of an object, or of each item of an array. */
  fields?: readonly ContextField[];
}

export const EXPRESSION_CONTEXT_KINDS = [
  'filter',
  'batchKey',
  'approval',
  'mapping',
  'step',
  'template',
] as const;
export type ExpressionContextKind = (typeof EXPRESSION_CONTEXT_KINDS)[number];

export const ARTIFACT_FIELDS: readonly ContextField[] = [
  { name: 'kind', type: 'string', description: 'What the artifact is, e.g. `github.pr`.' },
  { name: 'id', type: 'string', description: 'Its id within the source.' },
  { name: 'url', type: 'string', description: 'A link to it.', optional: true },
  {
    name: 'version',
    type: 'string',
    description: 'Its version when the event happened.',
    optional: true,
  },
];

export const EVENT_FIELDS: readonly ContextField[] = [
  { name: 'id', type: 'string', description: 'The event id.' },
  { name: 'sourceId', type: 'string', description: 'The source instance that received it.' },
  { name: 'sourceType', type: 'string', description: 'The source type, e.g. `github`.' },
  { name: 'type', type: 'string', description: 'The event type, e.g. `github.pr.labeled`.' },
  { name: 'occurredAt', type: 'datetime', description: 'When it happened, per the source.' },
  { name: 'receivedAt', type: 'datetime', description: 'When Switchboard received it.' },
  {
    name: 'artifact',
    type: 'object',
    description: 'The thing the event is about.',
    fields: ARTIFACT_FIELDS,
  },
  { name: 'attributes', type: 'object', description: "The event type's declared attributes." },
  { name: 'dedupeKey', type: 'string', description: 'Events with the same key make one run.' },
  { name: 'deliveryId', type: 'string', description: "The sender's delivery id.", optional: true },
  { name: 'rawRef', type: 'string', description: 'The stored raw delivery it came from.' },
  { name: 'replayOf', type: 'string', description: 'The event this one replays.', optional: true },
];

export const PROCESS_FIELDS: readonly ContextField[] = [
  { name: 'id', type: 'string', description: 'The process id.' },
  { name: 'name', type: 'string', description: 'The process name.' },
  { name: 'description', type: 'string', description: 'The process description.' },
  { name: 'enabled', type: 'boolean', description: 'Whether the process is on.' },
  { name: 'version', type: 'number', description: 'The saved version.', optional: true },
];

/** `run` in the input mapping and the approval rule: the run about to be invoked. */
export const RUN_CONTEXT_FIELDS: readonly ContextField[] = [
  { name: 'id', type: 'string', description: 'The run id; destinations use it to report back.' },
  { name: 'dryRun', type: 'boolean', description: 'A test run: not counted, no side effects.' },
  { name: 'mode', type: 'string', description: '`event`, `sweep` or `manual`.' },
  { name: 'processId', type: 'string', description: 'The process id.' },
  { name: 'processName', type: 'string', description: 'The process name.' },
  {
    name: 'callbackUrl',
    type: 'string',
    description: 'Where the destination reports status.',
    optional: true,
  },
  {
    name: 'deadline',
    type: 'datetime',
    description: 'When an unfinished run becomes `unknown`.',
    optional: true,
  },
];

/** `run` in steps and notification templates: the run as stored. */
export const RUN_FIELDS: readonly ContextField[] = [
  { name: 'id', type: 'string', description: 'The run id.' },
  { name: 'processId', type: 'string', description: 'The process id.' },
  { name: 'destinationId', type: 'string', description: 'The destination instance.' },
  { name: 'status', type: 'string', description: 'The run status, e.g. `ok` or `error`.' },
  { name: 'reason', type: 'string', description: 'Why it has that status.' },
  { name: 'mode', type: 'string', description: '`event`, `sweep` or `manual`.' },
  { name: 'dryRun', type: 'boolean', description: 'A test run.' },
  { name: 'externalId', type: 'string', description: "The destination's id for the run." },
  { name: 'externalUrl', type: 'string', description: 'A link to the run in the destination.' },
  { name: 'usage', type: 'object', description: 'Usage the destination reported.' },
  { name: 'invokedAt', type: 'datetime', description: 'When it was invoked.' },
  { name: 'finishedAt', type: 'datetime', description: 'When it finished.' },
];

export const BATCH_FIELDS: readonly ContextField[] = [
  { name: 'id', type: 'string', description: 'The batch id.' },
  { name: 'kind', type: 'string', description: '`event`, `sweep` or `manual`.' },
  { name: 'size', type: 'number', description: 'How many events it holds.', optional: true },
];

const EVENTS: ContextField = {
  name: 'events',
  type: 'array',
  description: 'The events of the batch, oldest first.',
  fields: EVENT_FIELDS,
};
const PROCESS: ContextField = {
  name: 'process',
  type: 'object',
  description: 'The process.',
  fields: PROCESS_FIELDS,
};

const FILTER_CONTEXT: readonly ContextField[] = [
  ...EVENT_FIELDS,
  {
    name: 'event',
    type: 'object',
    description: 'The event (its fields are also top-level).',
    fields: EVENT_FIELDS,
  },
  PROCESS,
  { name: 'now', type: 'datetime', description: 'The evaluation time.' },
];

const MAPPING_CONTEXT: readonly ContextField[] = [
  EVENTS,
  PROCESS,
  {
    name: 'run',
    type: 'object',
    description: 'The run about to be invoked.',
    fields: RUN_CONTEXT_FIELDS,
  },
  { name: 'mode', type: 'string', description: '`event` for event batches, `sweep` for sweeps.' },
];

export const EXPRESSION_CONTEXTS: Readonly<Record<ExpressionContextKind, readonly ContextField[]>> =
  {
    filter: FILTER_CONTEXT,
    batchKey: FILTER_CONTEXT,
    approval: [
      ...MAPPING_CONTEXT,
      {
        name: 'batch',
        type: 'object',
        description: 'The batch waiting at the gate.',
        fields: BATCH_FIELDS,
      },
    ],
    mapping: MAPPING_CONTEXT,
    step: [
      EVENTS,
      { name: 'run', type: 'object', description: 'The run.', fields: RUN_FIELDS },
      {
        name: 'result',
        type: 'object',
        description: "`after` steps only: the run's status, result, usage, errors and reason.",
        optional: true,
      },
    ],
    template: [
      PROCESS,
      EVENTS,
      { name: 'status', type: 'string', description: '`ok`, `error`, `held` or `throttled`.' },
      { name: 'batch', type: 'object', description: 'The batch.', fields: BATCH_FIELDS },
      { name: 'reason', type: 'string', description: 'Why the run or batch ended up here.' },
      {
        name: 'run',
        type: 'object',
        description: 'The run, for a run outcome.',
        fields: RUN_FIELDS,
        optional: true,
      },
      {
        name: 'bindingLimit',
        type: 'string',
        description: 'The ceiling that throttled it.',
        optional: true,
      },
    ],
  };

export interface SwitchboardFunction {
  /** The binding name; expressions call it with a `$`. */
  name: string;
  signature: string;
  description: string;
  /** False for names bound only to explain why they can't be used. */
  available: boolean;
}

export const SWITCHBOARD_FUNCTIONS = [
  {
    name: 'now',
    signature: '$now()',
    description: 'The evaluation time (ISO-8601).',
    available: true,
  },
  {
    name: 'millis',
    signature: '$millis()',
    description: 'The evaluation time in epoch ms.',
    available: true,
  },
  {
    name: 'env',
    signature: '$env(name)',
    description: 'A non-secret `SWITCHBOARD_VAR_` environment value.',
    available: true,
  },
  {
    name: 'secretRef',
    signature: "$secretRef('provider/name')",
    description: 'A secret reference, resolved only when the destination is called.',
    available: true,
  },
  {
    name: 'resolve',
    signature: '$resolve(artifact)',
    description: "The artifact's current state from its source (a bounded number of calls).",
    available: true,
  },
  {
    name: 'linked',
    signature: '$linked(artifact)',
    description: 'Artifacts linked to it, per its source.',
    available: true,
  },
  {
    name: 'secret',
    signature: '$secret(name)',
    description: 'Not available: expressions never read secret values; use `$secretRef`.',
    available: false,
  },
  { name: 'eval', signature: '$eval(expr)', description: 'Not available.', available: false },
] as const satisfies readonly SwitchboardFunction[];

export type SwitchboardFunctionName = (typeof SWITCHBOARD_FUNCTIONS)[number]['name'];
