import type { Expr, JSONSchema } from '@ai-switchboard/sdk';

/** `HH:MM` 24-hour clock times in the process's (or installation's) timezone. */
export interface QuietWindow {
  start: string;
  end: string;
  /** IANA timezone; defaults to the installation timezone. */
  timezone?: string;
  /** ISO weekdays 1 (Mon) – 7 (Sun) the window applies to; all days when omitted. */
  days?: number[];
}

export interface Trigger {
  /** Stable id within the process, used by dispatches. */
  id: string;
  sourceId: string;
  eventTypes: string[];
  filter?: Expr;
  describe: string;
  enabled: boolean;
}

export interface Schedule {
  id: string;
  cron: string;
  timezone: string;
  catchUp: 'skip' | 'once';
  enabled: boolean;
}

export interface Step {
  /** A source or destination instance id. */
  provider: string;
  action: string;
  args: Expr;
  when?: Expr;
}

export interface Notification {
  notifierId: string;
  template: Expr;
  on: ('ok' | 'error' | 'held' | 'throttled')[];
}

export interface MeterCeiling {
  /** Utilization % above which event-driven batches are throttled. */
  events: number;
  /** Utilization % above which sweeps are throttled. */
  sweeps: number;
}

export interface ProcessDocument {
  name: string;
  description: string;
  enabled: boolean;
  triggers: Trigger[];
  /** Sweeps; may be the only way a process starts. */
  schedules: Schedule[];
  batching: { debounceSeconds: number; maxSize: number; maxAgeSeconds: number; groupBy?: Expr };
  gates: {
    quietHours?: QuietWindow;
    /** `'none'`, `'always'`, or a JSONata expression over the batch. */
    approval: 'none' | 'always' | (Expr & {});
    breaker: { threshold: number; cooldownMinutes: number };
  };
  budgets: {
    runsPerHour?: number;
    runsPerDay?: number;
    /** Keyed by usage dimension id. */
    usagePerDay?: Record<string, number>;
    /** Keyed by meter id. */
    meterCeilings: Record<string, MeterCeiling>;
  };
  destination: { instanceId: string; target: unknown };
  /** JSONata over the batch context → the destination's inputSchema. */
  input: Expr;
  before: Step[];
  after: Step[];
  notify: Notification[];
  /** When an open run becomes `unknown`. */
  trackingDeadlineMinutes: number;
}

/** The TDD's `Process`: the stored document plus its identity. */
export interface Process extends ProcessDocument {
  id: string;
}

export function defaultProcessDocument(
  name: string,
  destinationInstanceId: string,
): ProcessDocument {
  return {
    name,
    description: '',
    enabled: false,
    triggers: [],
    schedules: [],
    batching: { debounceSeconds: 30, maxSize: 20, maxAgeSeconds: 600 },
    gates: { approval: 'none', breaker: { threshold: 3, cooldownMinutes: 60 } },
    budgets: { runsPerDay: 20, meterCeilings: {} },
    destination: { instanceId: destinationInstanceId, target: {} },
    input: '{ "mode": mode, "runId": run.id, "artifacts": events.artifact }',
    before: [],
    after: [],
    notify: [],
    trackingDeadlineMinutes: 120,
  };
}

const expr: JSONSchema = { type: 'string' };
const hhmm: JSONSchema = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' };
const step: JSONSchema = {
  type: 'object',
  required: ['provider', 'action', 'args'],
  additionalProperties: false,
  properties: { provider: { type: 'string' }, action: { type: 'string' }, args: expr, when: expr },
};

/** JSON Schema for a stored process document; the API validates every save against it. */
export const processDocumentSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'description',
    'enabled',
    'triggers',
    'schedules',
    'batching',
    'gates',
    'budgets',
    'destination',
    'input',
    'before',
    'after',
    'notify',
    'trackingDeadlineMinutes',
  ],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 2000 },
    enabled: { type: 'boolean' },
    triggers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'sourceId', 'eventTypes', 'describe', 'enabled'],
        properties: {
          id: { type: 'string', minLength: 1 },
          sourceId: { type: 'string', minLength: 1 },
          eventTypes: { type: 'array', items: { type: 'string' }, minItems: 1 },
          filter: expr,
          describe: { type: 'string' },
          enabled: { type: 'boolean' },
        },
      },
    },
    schedules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'cron', 'timezone', 'catchUp', 'enabled'],
        properties: {
          id: { type: 'string', minLength: 1 },
          cron: { type: 'string', minLength: 1 },
          timezone: { type: 'string', minLength: 1 },
          catchUp: { enum: ['skip', 'once'] },
          enabled: { type: 'boolean' },
        },
      },
    },
    batching: {
      type: 'object',
      additionalProperties: false,
      required: ['debounceSeconds', 'maxSize', 'maxAgeSeconds'],
      properties: {
        debounceSeconds: { type: 'integer', minimum: 0, maximum: 86_400 },
        maxSize: { type: 'integer', minimum: 1, maximum: 10_000 },
        maxAgeSeconds: { type: 'integer', minimum: 0, maximum: 604_800 },
        groupBy: expr,
      },
    },
    gates: {
      type: 'object',
      additionalProperties: false,
      required: ['approval', 'breaker'],
      properties: {
        quietHours: {
          type: 'object',
          additionalProperties: false,
          required: ['start', 'end'],
          properties: {
            start: hhmm,
            end: hhmm,
            timezone: { type: 'string' },
            days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 } },
          },
        },
        approval: { type: 'string', minLength: 1 },
        breaker: {
          type: 'object',
          additionalProperties: false,
          required: ['threshold', 'cooldownMinutes'],
          properties: {
            threshold: { type: 'integer', minimum: 1, maximum: 1000 },
            cooldownMinutes: { type: 'integer', minimum: 0, maximum: 100_000 },
          },
        },
      },
    },
    budgets: {
      type: 'object',
      additionalProperties: false,
      required: ['meterCeilings'],
      properties: {
        runsPerHour: { type: 'integer', minimum: 0 },
        runsPerDay: { type: 'integer', minimum: 0 },
        usagePerDay: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
        meterCeilings: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            required: ['events', 'sweeps'],
            properties: {
              events: { type: 'number', minimum: 0, maximum: 100 },
              sweeps: { type: 'number', minimum: 0, maximum: 100 },
            },
          },
        },
      },
    },
    destination: {
      type: 'object',
      additionalProperties: false,
      required: ['instanceId', 'target'],
      properties: { instanceId: { type: 'string' }, target: {} },
    },
    input: expr,
    before: { type: 'array', items: step },
    after: { type: 'array', items: step },
    notify: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['notifierId', 'template', 'on'],
        properties: {
          notifierId: { type: 'string' },
          template: expr,
          on: { type: 'array', items: { enum: ['ok', 'error', 'held', 'throttled'] } },
        },
      },
    },
    trackingDeadlineMinutes: { type: 'integer', minimum: 1, maximum: 100_000 },
  },
};
