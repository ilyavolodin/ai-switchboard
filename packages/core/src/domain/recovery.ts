import { isOneOf } from '@ai-switchboard/sdk/json';

export const RECOVERY_ERROR_CODES = [
  'unknown_user',
  'invalid_password',
  'invalid_email',
  'no_reason',
] as const;
export type RecoveryErrorCode = (typeof RECOVERY_ERROR_CODES)[number];

/** What a caller reads from the recovery service's `RecoveryError` (`services/recovery.ts`). */
export interface RecoveryErrorShape extends Error {
  readonly name: 'RecoveryError';
  readonly code: RecoveryErrorCode;
  /** Close existing emails for `unknown_user`. */
  readonly suggestions: string[];
}

/** Duck-typed, so the CLI can check an error without loading the server's modules. */
export function isRecoveryError(err: unknown): err is RecoveryErrorShape {
  if (!(err instanceof Error) || err.name !== 'RecoveryError') return false;
  const e = err as Partial<RecoveryErrorShape>;
  return isOneOf(RECOVERY_ERROR_CODES, e.code) && Array.isArray(e.suggestions);
}
