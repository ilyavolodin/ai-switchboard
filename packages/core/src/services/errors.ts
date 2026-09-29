/** A refusal a person can act on; the API answers it with `status` and the `ApiError` body. */
export class ServiceError extends Error {
  override readonly name = 'ServiceError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: string[],
    readonly usedBy?: { id: string; name: string }[],
  ) {
    super(message);
  }
}

export function isServiceError(err: unknown): err is ServiceError {
  return (
    err instanceof Error &&
    err.name === 'ServiceError' &&
    typeof (err as { status?: unknown }).status === 'number' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

export const notFound = (what: string): ServiceError =>
  new ServiceError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: string[]): ServiceError =>
  new ServiceError(400, 'bad_request', message, details);
export const forbidden = (message: string): ServiceError =>
  new ServiceError(403, 'forbidden', message);
export const conflict = (message: string, usedBy?: { id: string; name: string }[]): ServiceError =>
  new ServiceError(409, 'conflict', message, undefined, usedBy);
export const unprocessable = (message: string, details?: string[]): ServiceError =>
  new ServiceError(422, 'unprocessable', message, details);

/** The lines to show for a refusal in a list of problems (YAML apply reports them per entry). */
export function problemsOf(err: unknown): string[] {
  if (isServiceError(err))
    return err.details && err.details.length > 0 ? err.details : [err.message];
  throw err;
}
