import { describe, expect, it } from 'vitest';

import { createAjv } from './ajv.js';
import {
  UI_KEYWORDS,
  X_WIDGETS,
  isXWidget,
  xDocs,
  xEffectiveDefaults,
  xEnumLabels,
  xGroup,
  xHelp,
  xOrder,
  xPlaceholder,
  xSecret,
  xWarnings,
  xWidget,
  type SchemaUiExtensions,
} from './extensions.js';

describe('UI keywords', () => {
  it('lists every key of SchemaUiExtensions', () => {
    const keys: Record<keyof SchemaUiExtensions, true> = {
      'x-secret': true,
      'x-widget': true,
      'x-group': true,
      'x-order': true,
      'x-placeholder': true,
      'x-help': true,
      'x-warning': true,
      'x-enumLabels': true,
      'x-effectiveDefault': true,
      'x-docs': true,
    };
    expect([...UI_KEYWORDS].sort()).toEqual(Object.keys(keys).sort());
  });

  it('compiles a schema that uses them', () => {
    const schema: SchemaUiExtensions & Record<string, unknown> = {
      type: 'string',
      'x-widget': 'textarea',
      'x-warning': { when: { const: 'none' }, message: 'careful' },
    };
    expect(createAjv().validate(schema, 'x')).toBe(true);
  });

  it('fills defaults unless told not to', () => {
    const schema = { type: 'object', properties: { a: { type: 'number', default: 1 } } };
    const filled: Record<string, unknown> = {};
    createAjv().validate(schema, filled);
    expect(filled).toEqual({ a: 1 });
    const untouched: Record<string, unknown> = {};
    createAjv({ useDefaults: false }).validate(schema, untouched);
    expect(untouched).toEqual({});
  });
});

describe('extension parsers', () => {
  it.each([
    [{ 'x-widget': 'expression' }, 'expression'],
    [{ 'x-widget': 'password' }, 'password'],
    [{ 'x-widget': 'fancy' }, null],
    [{ 'x-widget': 3 }, null],
    [{}, null],
  ])('xWidget(%j) is %j', (schema, expected) => {
    expect(xWidget(schema)).toBe(expected);
  });

  it('knows every listed widget', () => {
    for (const w of X_WIDGETS) expect(isXWidget(w)).toBe(true);
    expect(isXWidget('select ')).toBe(false);
  });

  it('reads the scalar keywords', () => {
    const s = {
      'x-secret': true,
      'x-group': 'Auth',
      'x-order': ['b', 'a', 3],
      'x-placeholder': 'body.id',
      'x-help': '',
    };
    expect(xSecret(s)).toBe(true);
    expect(xSecret({ 'x-secret': 'yes' })).toBe(false);
    expect(xGroup(s)).toBe('Auth');
    expect(xOrder(s)).toEqual(['b', 'a', '3']);
    expect(xOrder({ 'x-order': 'a' })).toEqual([]);
    expect(xPlaceholder(s)).toBe('body.id');
    expect(xHelp(s)).toBeNull();
  });

  it('takes one warning or a list and drops malformed entries', () => {
    const one = { when: { const: 'none' }, message: 'open to anyone' };
    expect(xWarnings({ 'x-warning': one })).toEqual([one]);
    expect(
      xWarnings({
        'x-warning': [one, { when: true, message: 'always' }, { message: 'no when' }, { when: {} }],
      }),
    ).toEqual([one, { when: true, message: 'always' }]);
    expect(xWarnings({})).toEqual([]);
  });

  it('keeps only string enum labels', () => {
    expect(xEnumLabels({ 'x-enumLabels': { hmac: 'HMAC signature', none: 3 } })).toEqual({
      hmac: 'HMAC signature',
    });
    expect(xEnumLabels({ 'x-enumLabels': ['a'] })).toEqual({});
  });

  it('reads effective defaults with and without a condition', () => {
    expect(
      xEffectiveDefaults({
        'x-effectiveDefault': [
          { when: { properties: { mode: { const: 'push' } } }, value: 'header' },
          { value: 'none' },
          { when: 'bad', value: 'x' },
          { when: {} },
        ],
      }),
    ).toEqual([
      { when: { properties: { mode: { const: 'push' } } }, value: 'header' },
      { value: 'none' },
    ]);
    expect(xEffectiveDefaults({ 'x-effectiveDefault': { value: 1 } })).toEqual([]);
  });

  it('accepts only http(s) docs links', () => {
    expect(xDocs({ 'x-docs': { url: 'https://example.com/docs' } })).toEqual({
      url: 'https://example.com/docs',
      label: 'Documentation',
    });
    expect(xDocs({ 'x-docs': { url: 'http://x.test', label: 'Guide' } })).toEqual({
      url: 'http://x.test',
      label: 'Guide',
    });
    expect(xDocs({ 'x-docs': { url: 'javascript:alert(1)' } })).toBeNull();
    expect(xDocs({})).toBeNull();
  });
});
