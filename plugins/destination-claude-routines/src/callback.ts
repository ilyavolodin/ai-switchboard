import {
  verifyHmac,
  type CallbackResult,
  type JSONSchema,
  type RawRequest,
  type RunStatus,
  type UsageReport,
  tryParse,
} from '@ai-switchboard/sdk';

import { USAGE_DIMENSIONS } from './settings.js';

export const SIGNATURE_HEADER = 'x-switchboard-signature';
export const SIGNATURE_PREFIX = 'sha256=';

/** What the routine's completion step POSTs to the callback URL from the trailer. */
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

function declaredUsage(usage: Record<string, unknown> | undefined): UsageReport | undefined {
  if (!usage) return undefined;
  const out: UsageReport = {};
  for (const [key, value] of Object.entries(usage)) {
    if (DECLARED.has(key) && typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Authenticate the completion step's callback and map it to a run status. `null` for anything
 * unsigned, wrongly signed or malformed; never throws. Unknown fields and usage keys are ignored.
 */
export function verifyRoutineCallback(req: RawRequest, secret: string): CallbackResult | null {
  const ok = verifyHmac({
    secret,
    payload: req.body,
    signature: req.headers[SIGNATURE_HEADER],
    prefix: SIGNATURE_PREFIX,
  });
  if (!ok) return null;
  let json: unknown;
  try {
    json = JSON.parse(req.body.toString('utf8'));
  } catch {
    return null;
  }
  const body = tryParse<RoutineCallbackBody>(callbackBodySchema, json);
  if (!body) return null;
  const usage = declaredUsage(body.usage);
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
