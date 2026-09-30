import { pickDeclaredUsage, readSignedJson } from './protocol.js';
import { tryParse } from './schema/index.js';
import type { JSONSchema, RawRequest } from './types/common.js';
import type { CallbackResult, RunStatus } from './types/destination.js';

/** The completion callback a destination's backend posts, signed like every Switchboard request. */
export interface SwitchboardCallbackBody {
  runId: string;
  status: 'ok' | 'error';
  outputs?: number;
  errors?: string[];
  usage?: Record<string, unknown>;
  finishedAt?: string;
  externalUrl?: string;
}

export const CALLBACK_BODY_PROPERTIES: Record<string, JSONSchema> = {
  runId: { type: 'string', minLength: 1 },
  status: { enum: ['ok', 'error'] },
  outputs: { type: 'integer', minimum: 0 },
  errors: { type: 'array', items: { type: 'string' } },
  usage: { type: 'object', additionalProperties: { type: 'number' } },
  finishedAt: { type: 'string', format: 'date-time' },
  externalUrl: { type: 'string', format: 'uri' },
};

export const callbackBodySchema: JSONSchema = {
  type: 'object',
  required: ['runId', 'status'],
  properties: CALLBACK_BODY_PROPERTIES,
};

export interface CallbackOptions<T extends SwitchboardCallbackBody> {
  /** A schema for a backend's own body shape; defaults to `callbackBodySchema`. */
  schema?: JSONSchema;
  /** Where the run's link comes from; defaults to `body.externalUrl`. */
  externalUrl?: (body: T) => string | undefined;
}

/**
 * Authenticates and reads a completion callback. `null` for anything unsigned, wrongly signed or
 * malformed; never throws. Usage keys outside `declared` are dropped.
 */
export function verifySwitchboardCallback<
  T extends SwitchboardCallbackBody = SwitchboardCallbackBody,
>(
  req: RawRequest,
  secret: string | undefined,
  declared: ReadonlySet<string>,
  options: CallbackOptions<T> = {},
): CallbackResult | null {
  const body = tryParse<T>(options.schema ?? callbackBodySchema, readSignedJson(req, secret));
  if (!body) return null;
  const usage = pickDeclaredUsage(body.usage, declared);
  const externalUrl = options.externalUrl ? options.externalUrl(body) : body.externalUrl;
  const status: RunStatus = {
    state: body.status,
    ...(body.outputs !== undefined ? { outputs: body.outputs } : {}),
    ...(body.errors !== undefined ? { errors: body.errors } : {}),
    ...(usage ? { usage } : {}),
    ...(body.finishedAt !== undefined ? { finishedAt: body.finishedAt } : {}),
    ...(externalUrl !== undefined ? { externalUrl } : {}),
  };
  return { runId: body.runId, status };
}
