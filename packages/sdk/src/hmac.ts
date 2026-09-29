import { createHmac, timingSafeEqual } from 'node:crypto';

export interface HmacOptions {
  secret: string;
  payload: Buffer | string;
  algorithm?: 'sha256' | 'sha1' | 'sha512';
  encoding?: 'hex' | 'base64';
}

export function signHmac(options: HmacOptions): string {
  return createHmac(options.algorithm ?? 'sha256', options.secret)
    .update(options.payload)
    .digest(options.encoding ?? 'hex');
}

/**
 * Constant-time. `prefix` is stripped from `signature` first (GitHub sends `sha256=<hex>`).
 * Returns false for a missing or malformed signature; never throws.
 */
export function verifyHmac(
  options: HmacOptions & { signature: string | undefined; prefix?: string },
): boolean {
  const { signature, prefix = '' } = options;
  if (signature == null || signature === '' || options.secret === '') return false;
  if (!signature.startsWith(prefix)) return false;
  const given = signature.slice(prefix.length);
  const expected = signHmac(options);
  const encoding = options.encoding ?? 'hex';
  // Buffer.from stops decoding hex at the first bad character, so `<valid>zz` would decode to the
  // valid bytes; insist on the whole string being hex.
  if (encoding === 'hex' && !/^(?:[0-9a-fA-F]{2})+$/.test(given)) return false;
  const a = Buffer.from(given, encoding);
  const b = Buffer.from(expected, encoding);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Constant-time, for shared-secret headers. */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (a == null || b == null || b === '') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
