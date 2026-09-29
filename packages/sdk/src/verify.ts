import { safeEqual, verifyHmac, type HmacOptions } from './hmac.js';
import type { RawRequest, VerifyResult } from './types/common.js';

export interface HmacHeaderOptions extends Omit<HmacOptions, 'payload'> {
  /** Case-insensitive. */
  header: string;
  /** Stripped from the header value first, e.g. `sha256=`. */
  prefix?: string;
}

/** HMAC of the raw body against a signature header. Never throws. */
export function verifyHmacHeader(req: RawRequest, options: HmacHeaderOptions): VerifyResult {
  const { header: name, prefix, ...hmac } = options;
  const header = name.toLowerCase();
  const signature = req.headers[header];
  if (signature === undefined || signature === '') {
    return { ok: false, reason: `missing ${header} header` };
  }
  const ok = verifyHmac({
    ...hmac,
    payload: req.body,
    signature,
    ...(prefix !== undefined ? { prefix } : {}),
  });
  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/** A shared secret sent verbatim in a header, compared in constant time. Never throws. */
export function verifySharedSecretHeader(
  req: RawRequest,
  options: { header: string; secret: string },
): VerifyResult {
  const header = options.header.toLowerCase();
  const given = req.headers[header];
  if (given === undefined || given === '') return { ok: false, reason: `missing ${header} header` };
  return safeEqual(given, options.secret) ? { ok: true } : { ok: false, reason: 'secret mismatch' };
}
