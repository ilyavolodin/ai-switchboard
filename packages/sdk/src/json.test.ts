import { describe, expect, it } from 'vitest';

import { makeResponse } from './http.js';
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  errorText,
  getPath,
  isOneOf,
  isRecord,
  parseJsonObject,
  tryJson,
} from './json.js';

describe('json narrowing helpers', () => {
  it.each([
    ['an object', { a: 1 }, true],
    ['an array', [1], false],
    ['null', null, false],
    ['a string', 'x', false],
  ])('isRecord of %s is %s', (_label, value, expected) => {
    expect(isRecord(value)).toBe(expected);
    expect(asObject(value) !== undefined).toBe(expected);
  });

  it.each([
    [asString, 'x', 'x'],
    [asString, 1, undefined],
    [asNumber, 3, 3],
    [asNumber, Number.NaN, undefined],
    [asNumber, Number.POSITIVE_INFINITY, undefined],
    [asNumber, '3', undefined],
    [asBoolean, false, false],
    [asBoolean, 'true', undefined],
  ] as const)('%o narrows %o to %o', (fn, value, expected) => {
    expect((fn as (v: unknown) => unknown)(value)).toBe(expected);
  });

  it('asArray gives [] for a non-array', () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ length: 1 })).toEqual([]);
  });

  it.each([
    [{ a: { b: { c: 1 } } }, ['a', 'b', 'c'], 1],
    [{ a: { b: [1] } }, ['a', 'b', '0'], undefined],
    [{ a: null }, ['a', 'b'], undefined],
    [{ a: 2 }, [], { a: 2 }],
  ])('getPath(%o, %o) is %o', (value, keys, expected) => {
    expect(getPath(value, ...keys)).toEqual(expected);
  });

  it.each([
    ['{"a":1}', { a: 1 }],
    ['[1]', undefined],
    ['not json', undefined],
    ['', undefined],
  ])('parseJsonObject(%j)', (text, expected) => {
    expect(parseJsonObject(text)).toEqual(expected);
  });

  it.each([
    ['{"ok":true}', { ok: true }],
    ['<html>proxy</html>', undefined],
    ['', undefined],
  ])('tryJson of %j', (body, expected) => {
    expect(tryJson(makeResponse(200, {}, Buffer.from(body)))).toEqual(expected);
  });
});

describe('isOneOf and errorText', () => {
  it('isOneOf accepts only members of the list', () => {
    const modes = ['push', 'pull'] as const;
    expect(isOneOf(modes, 'push')).toBe(true);
    expect(isOneOf(modes, 'both')).toBe(false);
    expect(isOneOf(modes, 1)).toBe(false);
  });

  it('errorText reads an Error or stringifies anything else', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText(42)).toBe('42');
  });
});
