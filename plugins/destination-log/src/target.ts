import type { JSONSchema } from '@ai-switchboard/sdk';

export type Outcome = 'ok' | 'error' | 'failed' | 'held' | 'rate_limited';

export interface LogTarget {
  label?: string;
  outcome: Outcome;
  delayMs: number;
  retryAfterSeconds: number;
}

export const targetSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: {
      type: 'string',
      maxLength: 120,
      title: 'Label',
      description: 'A word to find this process in the log.',
    },
    outcome: {
      enum: ['ok', 'error', 'failed', 'held', 'rate_limited'],
      default: 'ok',
      title: 'Simulated outcome',
      description:
        'ok: the run succeeds. error: the backend reports an error (counts toward the breaker). failed: a definitive refusal. held: the target is paused. rate_limited: out of capacity (opens a soft-hold).',
    },
    delayMs: {
      type: 'integer',
      minimum: 0,
      maximum: 30_000,
      default: 0,
      title: 'Delay (ms)',
      description: 'Wait this long before answering, to see a run in flight.',
    },
    retryAfterSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 86_400,
      default: 60,
      title: 'Retry after (s)',
      description: 'For the rate_limited outcome: how long the soft-hold lasts.',
    },
  },
};

export const inputSchema: JSONSchema = {};
