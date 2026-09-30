import type { InstanceErrorCode } from './status.js';

/** Why an instance has no live object, or (`disabled`) why it takes no work. */
export interface InstanceError {
  code: InstanceErrorCode;
  /** What went wrong, for `secret_error` and `create_failed`; empty otherwise. */
  message: string;
}

/** The API's `instanceError` string: the code, then `: <message>` when there is one. */
export function formatInstanceError(error: InstanceError): string {
  return error.message === '' ? error.code : `${error.code}: ${error.message}`;
}

/** `formatInstanceError`, or null for an instance with nothing wrong: the DTO field's value. */
export function instanceErrorText(error: InstanceError | undefined): string | null {
  return error ? formatInstanceError(error) : null;
}
