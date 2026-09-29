import {
  pickDeclaredUsage,
  readSignedJson,
  tryParse,
  type CallbackResult,
  type JSONSchema,
  type RawRequest,
  type RunStatus,
} from '@ai-switchboard/sdk';

import { USAGE_DIMENSIONS } from './settings.js';

export interface RoutineCallbackBody {
  runId: string;
  status: 'ok' | 'error';
  sessionUrl?: string;
  outputs?: number;
  errors?: string[];
  usage?: Partial<
    Record<
      | 'input_tokens'
      | 'output_tokens'
      | 'cache_read_tokens'
      | 'cache_write_tokens'
      | 'duration_seconds',
      number
    >
  >;
  finishedAt?: string;
}

const count = { type: 'number', minimum: 0 };

export const callbackBodySchema: JSONSchema = {
  type: 'object',
  required: ['runId', 'status'],
  properties: {
    runId: { type: 'string', minLength: 1 },
    status: { enum: ['ok', 'error'] },
    sessionUrl: { type: 'string', format: 'uri', pattern: '^https://' },
    outputs: { type: 'integer', minimum: 0 },
    errors: { type: 'array', items: { type: 'string' } },
    usage: {
      type: 'object',
      properties: {
        input_tokens: count,
        output_tokens: count,
        cache_read_tokens: count,
        cache_write_tokens: count,
        duration_seconds: count,
      },
    },
    finishedAt: { type: 'string', format: 'date-time' },
  },
};

const DECLARED = new Set(USAGE_DIMENSIONS.map((d) => d.id));

/** `null` for anything unsigned, wrongly signed or malformed; never throws. */
export function verifyRoutineCallback(req: RawRequest, secret: string): CallbackResult | null {
  const body = tryParse<RoutineCallbackBody>(callbackBodySchema, readSignedJson(req, secret));
  if (!body) return null;
  const usage = pickDeclaredUsage(body.usage, DECLARED);
  const status: RunStatus = {
    state: body.status,
    ...(body.outputs !== undefined ? { outputs: body.outputs } : {}),
    ...(body.errors !== undefined ? { errors: body.errors } : {}),
    ...(usage ? { usage } : {}),
    ...(body.finishedAt !== undefined ? { finishedAt: body.finishedAt } : {}),
    ...(body.sessionUrl !== undefined ? { externalUrl: body.sessionUrl } : {}),
  };
  return { runId: body.runId, status };
}
