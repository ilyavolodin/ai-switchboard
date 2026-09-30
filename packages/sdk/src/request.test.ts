import { describe, expect, it } from 'vitest';

import { makeResponse } from './http.js';
import { headerValue, lowerCaseHeaders, responseSnippet } from './request.js';
import { rawRequest } from './testing/stubs.js';

describe('headerValue', () => {
  it.each([
    [{ 'x-delivery': 'd1' }, 'd1'],
    [{ 'x-delivery': '' }, undefined],
    [{}, undefined],
  ])('%j → %s', (headers, expected) => {
    expect(headerValue(rawRequest({ headers }), 'X-Delivery')).toBe(expected);
  });
});

describe('responseSnippet', () => {
  const res = (text: string) => makeResponse(500, {}, Buffer.from(text));

  it('trims and keeps a short body whole', () => {
    expect(responseSnippet(res('  oops \n'))).toBe('oops');
  });

  it('is empty for an empty body', () => {
    expect(responseSnippet(res(''))).toBe('');
  });

  it('cuts a long body with an ellipsis', () => {
    expect(responseSnippet(res('x'.repeat(30)), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});

describe('lowerCaseHeaders', () => {
  it('lower-cases names and keeps values', () => {
    expect(lowerCaseHeaders({ Authorization: 'Bearer A', 'X-Id': '1' })).toEqual({
      authorization: 'Bearer A',
      'x-id': '1',
    });
    expect(lowerCaseHeaders(undefined)).toEqual({});
  });
});
