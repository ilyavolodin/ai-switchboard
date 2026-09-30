import { isOneOf } from '@ai-switchboard/sdk';

/** What kind of refusal it is; only `api/errors.ts` turns a kind into an HTTP status. */
export const ERROR_KINDS = [
  'bad_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'unprocessable',
  'too_many_attempts',
  'unavailable',
  'internal',
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface DomainErrorOptions {
  /** The `ApiError.error` a client sees; defaults to the kind. */
  code?: string | undefined;
  details?: string[] | undefined;
  usedBy?: { id: string; name: string }[] | undefined;
}

/** A refusal a person can act on. */
export class DomainError extends Error {
  override readonly name: string = 'DomainError';
  readonly code: string;
  readonly details: string[] | undefined;
  readonly usedBy: { id: string; name: string }[] | undefined;

  constructor(
    readonly kind: ErrorKind,
    message: string,
    options: DomainErrorOptions = {},
  ) {
    super(message);
    this.code = options.code ?? kind;
    this.details = options.details;
    this.usedBy = options.usedBy;
  }
}

/** Duck-typed, so a subclass (`RecoveryError`) and a copy from another bundle both count. */
export function isDomainError(err: unknown): err is DomainError {
  if (!(err instanceof Error)) return false;
  const e = err as Partial<DomainError>;
  return isOneOf(ERROR_KINDS, e.kind) && typeof e.code === 'string';
}

export const notFound = (what: string): DomainError =>
  new DomainError('not_found', `${what} not found`);
export const badRequest = (message: string, details?: string[]): DomainError =>
  new DomainError('bad_request', message, { details });
/** A pipeline action refused on its input (the wire code stays `invalid`). */
export const invalid = (message: string): DomainError =>
  new DomainError('bad_request', message, { code: 'invalid' });
export const unauthenticated = (message: string, code?: string): DomainError =>
  new DomainError('unauthenticated', message, { code });
export const forbidden = (message: string): DomainError => new DomainError('forbidden', message);
export const conflict = (message: string, usedBy?: { id: string; name: string }[]): DomainError =>
  new DomainError('conflict', message, { usedBy });
export const unprocessable = (message: string, details?: string[], code?: string): DomainError =>
  new DomainError('unprocessable', message, { details, code });
export const unavailable = (message: string, code?: string): DomainError =>
  new DomainError('unavailable', message, { code });

/** The lines to show for a refusal in a list of problems (YAML apply reports them per entry). */
export function problemsOf(err: unknown): string[] {
  if (isDomainError(err))
    return err.details && err.details.length > 0 ? err.details : [err.message];
  throw err;
}
