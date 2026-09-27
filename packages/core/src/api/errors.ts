import type { FastifyError, FastifyInstance } from 'fastify';

import { isPipelineError } from '../services/pipeline/errors.js';
import type { ApiError } from './contract.js';

/** Throw from a route or service to send a structured error response. */
export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
  }
}

export const notFound = (what: string): HttpError =>
  new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: string[]): HttpError =>
  new HttpError(400, 'bad_request', message, details);
export const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message);
export const unprocessable = (message: string, details?: string[]): HttpError =>
  new HttpError(422, 'unprocessable', message, details);

/** Every mutation carries a non-empty one-line reason. */
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
  app.setErrorHandler((err: FastifyError | HttpError | Error, req, reply) => {
    if (err instanceof HttpError) {
      const body: ApiError = {
        error: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
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
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: 'internal',
      message: 'Something went wrong; the error is logged.',
    } satisfies ApiError);
  });
}
