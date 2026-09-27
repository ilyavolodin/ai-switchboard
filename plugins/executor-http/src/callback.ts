import {
  verifyHmac,
  type CallbackResult,
  type JSONSchema,
  type RawRequest,
  type RunStatus,
  type UsageReport,
  tryParse,
} from '@ai-switchboard/sdk';

export const SIGNATURE_HEADER = 'x-switchboard-signature';
export const SIGNATURE_PREFIX = 'sha256=';

/** What the backend POSTs to `run.callbackUrl` when a callback-tracked run finishes. */
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

/** Keep only declared, finite dimensions. */
export function declaredUsage(
  usage: Record<string, unknown> | undefined,
  declared: ReadonlySet<string>,
): UsageReport | undefined {
  if (!usage) return undefined;
  const out: UsageReport = {};
  for (const [key, value] of Object.entries(usage)) {
    if (declared.has(key) && typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Authenticate a callback (HMAC-SHA256 of the raw body) and map it to a run status. Returns
 * `null` for anything unsigned, wrongly signed or malformed; never throws. Unknown top-level
 * fields are ignored and undeclared usage keys are dropped.
 */
export function verifySignedCallback(
  req: RawRequest,
  secret: string | undefined,
  declared: ReadonlySet<string>,
): CallbackResult | null {
  if (secret === undefined || secret === '') return null;
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
  const body = tryParse<HttpCallbackBody>(callbackBodySchema, json);
  if (!body) return null;
  const usage = declaredUsage(body.usage, declared);
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
