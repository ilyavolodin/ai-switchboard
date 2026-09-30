import type { FastifyError, FastifyInstance } from 'fastify';

import { badRequest, isServiceError, type ServiceError } from '../services/errors.js';
import { isPipelineError } from '../services/pipeline/errors.js';
import type { ApiError } from '../contract/index.js';

export {
  badRequest,
  conflict,
  forbidden,
  notFound,
  ServiceError as HttpError,
  unprocessable,
} from '../services/errors.js';

/**
 * When `requireReasons` is off, the `preValidation` hook in `reasons.ts` has already filled a
 * missing reason, so this check is the same in both modes.
 */
export function requireReason(body: unknown): string {
  const reason =
    body !== null && typeof body === 'object' && 'reason' in body ? body.reason : undefined;
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw badRequest('A reason is required for every change.', [
      'reason must be a non-empty string',
    ]);
  }
  return reason.trim().slice(0, 500);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ServiceError | Error, req, reply) => {
    if (isServiceError(err)) {
      const body: ApiError = {
        error: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
        ...(err.usedBy ? { usedBy: err.usedBy } : {}),
      };
      return reply.code(err.status).send(body);
    }
    if (isPipelineError(err)) {
      // `unavailable` is a 503 (retry later), not an internal error.
      return reply
        .code(err.status)
        .send({ error: err.code, message: err.message } satisfies ApiError);
    }
    const fe = err as FastifyError;
    if (fe.validation) {
      const body: ApiError = {
        error: 'bad_request',
        message: 'The request did not validate.',
        details: fe.validation.map((v) =>
          `${v.instancePath || '(body)'} ${v.message ?? ''}`.trim(),
        ),
      };
      return reply.code(400).send(body);
    }
    if (typeof fe.statusCode === 'number' && fe.statusCode < 500) {
      return reply
        .code(fe.statusCode)
        .send({ error: fe.code || 'bad_request', message: fe.message } satisfies ApiError);
    }
    // A malformed id in the path (Postgres invalid_text_representation) is simply not found.
    const pgCode =
      (err as { code?: unknown; cause?: { code?: unknown } }).cause?.code ??
      (err as { code?: unknown }).code;
    if (pgCode === '22P02') {
      return reply.code(404).send({ error: 'not_found', message: 'Not found.' } satisfies ApiError);
    }
    // A unique index refused the write (a name already taken, or a concurrent create won).
    if (pgCode === '23505') {
      req.log.warn({ err }, 'unique constraint refused a write');
      return reply.code(409).send({
        error: 'conflict',
        message: 'That conflicts with an existing entry (the name may already be taken).',
      } satisfies ApiError);
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: 'internal',
      message: 'Something went wrong; the error is logged.',
    } satisfies ApiError);
  });
}
