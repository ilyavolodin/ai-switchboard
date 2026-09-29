import type { JSONSchema, RunHandle } from '@ai-switchboard/sdk';

export interface RoutineTarget {
  routineId: string;
}

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
        'Handed to the routine. The destination appends a delimited trailer with the run id and callback URL.',
    },
  },
};

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
