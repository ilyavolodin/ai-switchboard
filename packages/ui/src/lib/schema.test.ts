import type { JSONSchema } from '@ai-switchboard/core/contract';
import { describe, expect, it } from 'vitest';

import { pickWidget, type Widget } from './schema.js';

describe('pickWidget', () => {
  it.each<[string, JSONSchema, Widget]>([
    ['a plain string', { type: 'string' }, 'text'],
    [
      'a secret, whatever else it says',
      { type: 'string', 'x-secret': true, enum: ['a'] },
      'secret',
    ],
    ['an enum', { type: 'string', enum: ['a', 'b'] }, 'select'],
    ['an enum asking for radios', { enum: ['a', 'b'], 'x-widget': 'radio' }, 'radio'],
    ['radios without choices', { type: 'string', 'x-widget': 'radio' }, 'text'],
    ['a select over examples', { type: 'string', 'x-widget': 'select', examples: ['x'] }, 'select'],
    ['a select with nothing to choose', { type: 'string', 'x-widget': 'select' }, 'text'],
    ['a boolean', { type: 'boolean' }, 'toggle'],
    ['an integer', { type: 'integer' }, 'number'],
    ['a number asking for a textarea', { type: 'number', 'x-widget': 'textarea' }, 'number'],
    ['a list of strings', { type: 'array', items: { type: 'string' } }, 'list'],
    ['a cron', { type: 'string', 'x-widget': 'cron' }, 'cron'],
    ['an expression', { type: 'string', 'x-widget': 'expression' }, 'expression'],
    ['a path', { type: 'string', 'x-widget': 'path' }, 'path'],
    ['a textarea', { type: 'string', 'x-widget': 'textarea' }, 'textarea'],
    ['code', { type: 'string', 'x-widget': 'code' }, 'code'],
    ['json', { type: 'string', 'x-widget': 'json' }, 'json'],
    ['a password', { type: 'string', 'x-widget': 'password' }, 'password'],
    ['an unknown widget', { type: 'string', 'x-widget': 'colour' }, 'text'],
    ['a nullable string', { type: ['string', 'null'] }, 'text'],
  ])('%s', (_, schema, widget) => {
    expect(pickWidget(schema)).toBe(widget);
  });
});
