import { describe, expect, it } from 'vitest';

import { signHmac } from './hmac.js';
import { rawRequest } from './testing/stubs.js';
import { verifyHmacHeader, verifySharedSecretHeader } from './verify.js';

const secret = 'fixture-secret';
const body = '{"a":1}';
const signed = `sha256=${signHmac({ secret, payload: body })}`;

describe('verifyHmacHeader', () => {
  it.each([
    ['a correct signature', { 'X-Sig': signed }, { ok: true }],
    ['a missing header', {}, { ok: false, reason: 'missing x-sig header' }],
    ['an empty header', { 'x-sig': '' }, { ok: false, reason: 'missing x-sig header' }],
    ['a wrong signature', { 'x-sig': 'sha256=00' }, { ok: false, reason: 'signature mismatch' }],
    ['a missing prefix', { 'x-sig': signed.slice(7) }, { ok: false, reason: 'signature mismatch' }],
  ])('%s', (_label, headers, expected) => {
    const req = rawRequest({ headers, body });
    expect(verifyHmacHeader(req, { header: 'X-Sig', secret, prefix: 'sha256=' })).toEqual(expected);
  });

  it('honours algorithm and encoding', () => {
    const signature = signHmac({ secret, payload: body, algorithm: 'sha1', encoding: 'base64' });
    const req = rawRequest({ headers: { 'x-sig': signature }, body });
    expect(
      verifyHmacHeader(req, { header: 'x-sig', secret, algorithm: 'sha1', encoding: 'base64' }),
    ).toEqual({ ok: true });
  });
});

describe('verifySharedSecretHeader', () => {
  it.each([
    ['the secret', { 'x-token': secret }, { ok: true }],
    ['a missing header', {}, { ok: false, reason: 'missing x-token header' }],
    ['another value', { 'x-token': 'nope' }, { ok: false, reason: 'secret mismatch' }],
  ])('%s', (_label, headers, expected) => {
    expect(
      verifySharedSecretHeader(rawRequest({ headers }), { header: 'X-Token', secret }),
    ).toEqual(expected);
  });
});
