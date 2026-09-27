import { describe, expect, it } from 'vitest';

import {
  coerceAttribute,
  compileEventTypes,
  customEventTypePattern,
  eventTypeDefinitionSchema,
  narrowMapped,
  toIsoTime,
  validateAgainst,
  type EventTypeDefinition,
} from './index.js';

const defs: EventTypeDefinition[] = [
  {
    type: 'poll-http.deploy.finished',
    title: 'Deploy finished',
    attributes: [
      { name: 'env', type: 'string' },
      { name: 'count', type: 'number' },
      { name: 'env', type: 'number' },
    ],
    example: { env: 'prod' },
  },
  { type: 'webhook.deploy.finished', title: 'Foreign namespace', attributes: [] },
  { type: 'poll-http.deploy.finished', title: 'Duplicate', attributes: [] },
];

describe('custom event types', () => {
  it('scopes type ids to the source namespace', () => {
    const pattern = new RegExp(customEventTypePattern('poll-http'));
    expect(pattern.test('poll-http.incident.opened')).toBe(true);
    expect(pattern.test('webhook.incident.opened')).toBe(false);
    expect(pattern.test('poll-httpXincident.opened')).toBe(false);
    const schema = eventTypeDefinitionSchema('poll-http', 'poll-http.incident.opened');
    expect(validateAgainst(schema, defs[0]).valid).toBe(true);
    expect(validateAgainst(schema, defs[1]).valid).toBe(false);
  });

  it('compiles definitions: first wins, foreign types skipped, placeholders fill the example', () => {
    const types = compileEventTypes('poll-http', defs);
    expect([...types.keys()]).toEqual(['poll-http.deploy.finished']);
    const spec = types.get('poll-http.deploy.finished')?.spec;
    expect(spec?.title).toBe('Deploy finished');
    expect(spec?.examples).toEqual([{ env: 'prod', count: 0 }]);
    expect(Object.keys(spec?.attributes.properties ?? {})).toEqual(['env', 'count']);
  });

  it('narrows a mapping result, coercing declared attributes and dropping the rest', () => {
    const types = compileEventTypes('poll-http', defs);
    expect(
      narrowMapped(
        {
          type: 'poll-http.deploy.finished',
          artifact: { kind: 'deploy', id: 42 },
          attributes: { env: 7, count: '3', secret: 'x' },
          occurredAt: 1_700_000_000,
        },
        types,
      ),
    ).toEqual({
      type: 'poll-http.deploy.finished',
      artifact: { kind: 'deploy', id: '42' },
      attributes: { env: '7', count: 3 },
      occurredAt: '2023-11-14T22:13:20.000Z',
      deliveryId: undefined,
    });
    expect(narrowMapped({ type: 'poll-http.other.thing', artifact: {} }, types)).toBeNull();
    expect(
      narrowMapped({ type: 'poll-http.deploy.finished', artifact: { kind: 'x' } }, types),
    ).toBeNull();
  });

  it('coerces forgivingly and normalises times', () => {
    expect(coerceAttribute('true', 'boolean')).toBe(true);
    expect(coerceAttribute(' ', 'number')).toBeUndefined();
    expect(coerceAttribute(['a', 1, {}], 'string[]')).toEqual(['a', '1']);
    expect(toIsoTime(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(toIsoTime('not a date')).toBeUndefined();
  });
});
