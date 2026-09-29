import { signHmac, verifyHmac } from './hmac.js';
import type { RawRequest } from './types/common.js';
import type { UsageReport } from './types/destination.js';

/** Carries `sha256=<hex HMAC-SHA256 of the raw body>` on Switchboard-signed requests. */
export const SWITCHBOARD_SIGNATURE_HEADER = 'x-switchboard-signature';
export const SWITCHBOARD_SIGNATURE_PREFIX = 'sha256=';
/** Sent with every invoke of the HTTP destination, so an endpoint can deduplicate. */
export const SWITCHBOARD_RUN_ID_HEADER = 'x-switchboard-run-id';

/** The value for `x-switchboard-signature`. */
export function signSwitchboardBody(secret: string, body: string | Buffer): string {
  return `${SWITCHBOARD_SIGNATURE_PREFIX}${signHmac({ secret, payload: body })}`;
}

/** False for a missing secret, a missing header or a wrong signature. Never throws. */
export function verifySwitchboardSignature(req: RawRequest, secret: string | undefined): boolean {
  if (secret === undefined || secret === '') return false;
  return verifyHmac({
    secret,
    payload: req.body,
    signature: req.headers[SWITCHBOARD_SIGNATURE_HEADER],
    prefix: SWITCHBOARD_SIGNATURE_PREFIX,
  });
}

/**
 * The JSON body of a correctly signed request, or `undefined` when the signature or the JSON is
 * bad. Validate the result against a schema before trusting its shape.
 */
export function readSignedJson(req: RawRequest, secret: string | undefined): unknown {
  if (!verifySwitchboardSignature(req, secret)) return undefined;
  try {
    return JSON.parse(req.body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Finite numbers in declared dimensions only; `undefined` when nothing is left. */
export function pickDeclaredUsage(
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
