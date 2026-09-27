import { InvokeError, type JSONSchema, type RunHandle } from '@ai-switchboard/sdk';

import { SchemaMismatchError, parseWith } from './validate.js';

/** Which routine a process fires. */
export interface RoutineTarget {
  routineId: string;
}

/** What the input mapping produces: the text handed to the routine. */
export interface RoutineInput {
  text: string;
}

export const targetSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'Routine',
  description: 'The routine to fire.',
  required: ['routineId'],
  additionalProperties: false,
  properties: {
    routineId: {
      type: 'string',
      pattern: '^[A-Za-z0-9_-]+$',
      title: 'Routine id',
      description: "The routine's trigger id, from its API trigger URL (e.g. `trig_01AbC…`).",
      'x-placeholder': 'trig_01ABCDEF',
    },
  },
};

export const inputSchema: JSONSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'Routine input',
  description:
    'The text the routine receives as untrusted data. Prefer references (repo, issue number, mode) over free text.',
  required: ['text'],
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      title: 'Text',
      description:
        'Handed to the routine. The executor appends a delimited trailer with the run id and callback URL.',
    },
  },
};

function definitive<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SchemaMismatchError)
      throw new InvokeError(err.message, { definitive: true });
    throw err;
  }
}

export function readTarget(target: unknown): RoutineTarget {
  return definitive(() => parseWith<RoutineTarget>(targetSchema, target, 'routine target'));
}

export function readInput(input: unknown): RoutineInput {
  return definitive(() => parseWith<RoutineInput>(inputSchema, input, 'routine input'));
}

export const TRAILER_START = '--- switchboard ---';
export const TRAILER_END = '--- end switchboard ---';

/**
 * Append the delimited trailer the routine's completion step reads to echo the run id back.
 * It goes last so no mapped text can pretend to be it.
 */
export function withTrailer(text: string, run: RunHandle): string {
  const lines = [
    TRAILER_START,
    `switchboard_run_id: ${run.id}`,
    `switchboard_callback_url: ${run.callbackUrl}`,
    ...(run.dryRun ? ['switchboard_dry_run: true'] : []),
    TRAILER_END,
  ];
  return `${text.replace(/\s+$/, '')}\n\n${lines.join('\n')}\n`;
}
