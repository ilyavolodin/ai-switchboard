/** Why a pipeline action could not be carried out; the API maps `code` to an HTTP status. */
export type PipelineErrorCode = 'not_found' | 'conflict' | 'invalid' | 'unavailable';

export class PipelineError extends Error {
  override readonly name = 'PipelineError';

  constructor(
    readonly code: PipelineErrorCode,
    message: string,
  ) {
    super(message);
  }

  /** Fastify's error handler reads `statusCode` for client errors. */
  get statusCode(): number {
    return this.status;
  }

  /** The HTTP status the API should answer with. */
  get status(): number {
    switch (this.code) {
      case 'not_found':
        return 404;
      case 'conflict':
        return 409;
      case 'invalid':
        return 400;
      case 'unavailable':
        return 503;
    }
  }
}

export function isPipelineError(err: unknown): err is PipelineError {
  return err instanceof Error && err.name === 'PipelineError' && 'code' in err;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID.test(value);
}
