import {
  verifySwitchboardCallback,
  type CallbackResult,
  type RawRequest,
  type SwitchboardCallbackBody,
} from '@ai-switchboard/sdk';

export interface HttpCallbackBody extends SwitchboardCallbackBody {
  usage?: Record<string, number>;
}

/**
 * HMAC-SHA256 of the raw body. `null` for anything unsigned, wrongly signed or malformed; never
 * throws. Undeclared usage keys are dropped.
 */
export function verifySignedCallback(
  req: RawRequest,
  secret: string | undefined,
  declared: ReadonlySet<string>,
): CallbackResult | null {
  return verifySwitchboardCallback<HttpCallbackBody>(req, secret, declared);
}
