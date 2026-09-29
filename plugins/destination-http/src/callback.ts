import {
  pickDeclaredUsage,
  readSignedJson,
  tryParse,
  type CallbackResult,
  type JSONSchema,
  type RawRequest,
  type RunStatus,
} from '@ai-switchboard/sdk';

export interface HttpCallbackBody {
  runId: string;
  status: 'ok' | 'error';
  outputs?: number;
  errors?: string[];
  usage?: Record<string, number>;
  finishedAt?: string;
  externalUrl?: string;
}

export const callbackBodySchema: JSONSchema = {
  type: 'object',
  required: ['runId', 'status'],
  properties: {
    runId: { type: 'string', minLength: 1 },
    status: { enum: ['ok', 'error'] },
    outputs: { type: 'integer', minimum: 0 },
    errors: { type: 'array', items: { type: 'string' } },
    usage: { type: 'object', additionalProperties: { type: 'number' } },
    finishedAt: { type: 'string', format: 'date-time' },
    externalUrl: { type: 'string', format: 'uri' },
  },
};

/**
 * HMAC-SHA256 of the raw body. `null` for anything unsigned, wrongly signed or malformed; never
 * throws. Undeclared usage keys are dropped.
 */
export function verifySignedCallback(
  req: RawRequest,
  secret: string | undefined,
  declared: ReadonlySet<string>,
): CallbackResult | null {
  const body = tryParse<HttpCallbackBody>(callbackBodySchema, readSignedJson(req, secret));
  if (!body) return null;
  const usage = pickDeclaredUsage(body.usage, declared);
  const status: RunStatus = {
    state: body.status,
    ...(body.outputs !== undefined ? { outputs: body.outputs } : {}),
    ...(body.errors !== undefined ? { errors: body.errors } : {}),
    ...(usage ? { usage } : {}),
    ...(body.finishedAt !== undefined ? { finishedAt: body.finishedAt } : {}),
    ...(body.externalUrl !== undefined ? { externalUrl: body.externalUrl } : {}),
  };
  return { runId: body.runId, status };
}
