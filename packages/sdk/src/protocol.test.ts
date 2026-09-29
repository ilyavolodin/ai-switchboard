import { describe, expect, it } from 'vitest';

import {
  pickDeclaredUsage,
  readSignedJson,
  signSwitchboardBody,
  SWITCHBOARD_SIGNATURE_HEADER,
  verifySwitchboardSignature,
} from './protocol.js';
import { rawRequest } from './testing/stubs.js';

const secret = 'fixture-secret';
const body = '{"runId":"r1"}';

function signed(text: string, key = secret): ReturnType<typeof rawRequest> {
  return rawRequest({
    headers: { [SWITCHBOARD_SIGNATURE_HEADER]: signSwitchboardBody(key, text) },
    body: text,
  });
}

describe('Switchboard signatures', () => {
  it('signs as sha256=<hex>', () => {
    expect(signSwitchboardBody(secret, body)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it.each([
    ['a correct signature', signed(body), secret, true],
    ['another key', signed(body, 'other'), secret, false],
    ['no header', rawRequest({ body }), secret, false],
    ['no secret configured', signed(body), undefined, false],
    ['an empty secret', signed(body), '', false],
  ])('verifySwitchboardSignature: %s', (_label, req, key, expected) => {
    expect(verifySwitchboardSignature(req, key)).toBe(expected);
  });

  it.each([
    ['signed JSON', signed(body), { runId: 'r1' }],
    ['signed non-JSON', signed('not json'), undefined],
    ['unsigned JSON', rawRequest({ body }), undefined],
  ])('readSignedJson: %s', (_label, req, expected) => {
    expect(readSignedJson(req, secret)).toEqual(expected);
  });
});

describe('pickDeclaredUsage', () => {
  const declared = new Set(['tokens', 'seconds']);
  it.each([
    [undefined, undefined],
    [{}, undefined],
    [{ tokens: 5, other: 1 }, { tokens: 5 }],
    [{ tokens: '5', seconds: Number.NaN }, undefined],
    [
      { tokens: 0, seconds: 2.5 },
      { tokens: 0, seconds: 2.5 },
    ],
  ])('%o → %o', (usage, expected) => {
    expect(pickDeclaredUsage(usage, declared)).toEqual(expected);
  });
});
