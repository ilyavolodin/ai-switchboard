import { describe, expect, it } from 'vitest';

import {
  CALLBACK_BODY_PROPERTIES,
  verifySwitchboardCallback,
  type SwitchboardCallbackBody,
} from './protocol-callback.js';
import { signSwitchboardBody, SWITCHBOARD_SIGNATURE_HEADER } from './protocol.js';
import { rawRequest } from './testing/stubs.js';

const secret = 'fixture-secret';
const declared = new Set(['tokens']);

function signed(body: unknown, key = secret): ReturnType<typeof rawRequest> {
  const text = JSON.stringify(body);
  return rawRequest({
    headers: { [SWITCHBOARD_SIGNATURE_HEADER]: signSwitchboardBody(key, text) },
    body: text,
  });
}

describe('verifySwitchboardCallback', () => {
  it('maps a signed body to the run status, keeping declared usage only', () => {
    const req = signed({
      runId: 'r1',
      status: 'ok',
      outputs: 2,
      usage: { tokens: 10, other: 3 },
      finishedAt: '2026-09-30T12:00:00.000Z',
      externalUrl: 'https://example.com/r1',
    });
    expect(verifySwitchboardCallback(req, secret, declared)).toEqual({
      runId: 'r1',
      status: {
        state: 'ok',
        outputs: 2,
        usage: { tokens: 10 },
        finishedAt: '2026-09-30T12:00:00.000Z',
        externalUrl: 'https://example.com/r1',
      },
    });
  });

  it.each([
    ['a wrong signature', signed({ runId: 'r1', status: 'ok' }, 'other')],
    ['a body without runId', signed({ status: 'ok' })],
    ['an unknown status', signed({ runId: 'r1', status: 'maybe' })],
    ['an unsigned body', rawRequest({ body: '{"runId":"r1","status":"ok"}' })],
  ])('rejects %s', (_label, req) => {
    expect(verifySwitchboardCallback(req, secret, declared)).toBeNull();
  });

  it('takes a backend schema and its own link field', () => {
    interface Body extends SwitchboardCallbackBody {
      sessionUrl?: string;
    }
    const schema = {
      type: 'object',
      required: ['runId', 'status'],
      properties: { ...CALLBACK_BODY_PROPERTIES, sessionUrl: { type: 'string' } },
    };
    const req = signed({ runId: 'r1', status: 'error', errors: ['x'], sessionUrl: 'https://s/1' });
    expect(
      verifySwitchboardCallback<Body>(req, secret, declared, {
        schema,
        externalUrl: (b) => b.sessionUrl,
      }),
    ).toEqual({
      runId: 'r1',
      status: { state: 'error', errors: ['x'], externalUrl: 'https://s/1' },
    });
  });
});
