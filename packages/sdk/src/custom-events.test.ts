import { describe, expect, it } from 'vitest';

import {
  coerceAttribute,
  compileEventTypes,
  customEventTypePattern,
  describeMappedDrop,
  draftFromMapped,
  eventTypeDefinitionSchema,
  attributeKey,
  flattenAttributes,
  narrowMapped,
  openAttributesSchema,
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

describe('open attribute schemas (1.4)', () => {
  it('accepts any flat key and still refuses nested values', () => {
    const schema = openAttributesSchema({ status: { type: 'string' } });
    expect(validateAgainst(schema, { status: 'ok', count: 3, tags: ['a'], on: true }).valid).toBe(
      true,
    );
    expect(validateAgainst(schema, { status: 3 }).valid).toBe(false);
    expect(validateAgainst(schema, { nested: { a: 1 } }).valid).toBe(false);
    expect(validateAgainst(schema, { list: [1, 2] }).valid).toBe(false);
  });

  it('flattens top-level fields and one level of nesting with filter-friendly keys', () => {
    const body = {
      action: 'opened',
      number: 7,
      draft: false,
      labels: ['bug', 3],
      'x-kind': 'pr',
      '1st': 'yes',
      pull_request: { id: 99, head: { ref: 'main' }, title: 'Fix' },
      reviewers: [{ login: 'a' }],
      nothing: null,
      huge: 'x'.repeat(2000),
    };
    expect(flattenAttributes(body)).toEqual({
      action: 'opened',
      number: 7,
      draft: false,
      labels: ['bug', '3'],
      x_kind: 'pr',
      _1st: 'yes',
      pull_request_id: 99,
      pull_request_title: 'Fix',
    });
    expect(flattenAttributes(body, { depth: 0 })).not.toHaveProperty('pull_request_id');
    expect(Object.keys(flattenAttributes(body, { maxAttributes: 2 }))).toEqual([
      'action',
      'number',
    ]);
    expect(flattenAttributes('text')).toEqual({});
    expect(flattenAttributes([1, 2])).toEqual({});
    expect(attributeKey('x-github-event')).toBe('x_github_event');
    for (const key of Object.keys(flattenAttributes(body))) {
      expect(key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });
});

describe('describeMappedDrop', () => {
  const types = compileEventTypes('poll-http', defs);
  it.each([
    ['not an object', 'x', 'Mapping result 2 is not an object, so it was dropped.'],
    ['no type', {}, 'Mapping result 2 has no "type", so it was dropped.'],
    [
      'an undeclared type',
      { type: 'poll-http.other.thing' },
      `Mapping result 2 has type poll-http.other.thing, which is not one of the event types (${[...types.keys()].join(', ')}), so it was dropped.`,
    ],
    [
      'no artifact',
      { type: 'poll-http.deploy.finished' },
      'Mapping result 2 (poll-http.deploy.finished) needs an artifact with a "kind" and an "id", so it was dropped.',
    ],
  ])('names why a result with %s was dropped', (_label, item, expected) => {
    expect(describeMappedDrop(item, types, 1)).toBe(expected);
  });
});

describe('draftFromMapped', () => {
  const artifact = { kind: 'deploy', id: 'd1' };
  const mapped = {
    type: 'poll-http.deploy.finished',
    artifact,
    attributes: {},
    occurredAt: undefined,
    deliveryId: undefined,
  };
  it.each([
    [
      'the fallbacks when the mapping gave nothing',
      mapped,
      { occurredAt: 't0', fallbackDiscriminator: 'hash' },
      { occurredAt: 't0', dedupeKey: 'poll-http.deploy.finished:deploy:d1:hash' },
    ],
    [
      'the option delivery id over the discriminator',
      mapped,
      { occurredAt: 't0', deliveryId: 'del-1', fallbackDiscriminator: 'hash' },
      { deliveryId: 'del-1', dedupeKey: 'poll-http.deploy.finished:deploy:d1:del-1' },
    ],
    [
      'the mapped values over the options',
      { ...mapped, occurredAt: 't1', deliveryId: 'del-2' },
      { occurredAt: 't0', deliveryId: 'del-1' },
      {
        occurredAt: 't1',
        deliveryId: 'del-2',
        dedupeKey: 'poll-http.deploy.finished:deploy:d1:del-2',
      },
    ],
    [
      'the artifact version over any delivery id',
      { ...mapped, artifact: { ...artifact, version: 'v3' }, deliveryId: 'del-2' },
      { occurredAt: 't0' },
      { dedupeKey: 'poll-http.deploy.finished:deploy:d1:v3' },
    ],
  ])('uses %s', (_label, input, options, expected) => {
    expect(draftFromMapped(input, options)).toMatchObject(expected);
  });

  it('omits deliveryId when there is none', () => {
    expect(draftFromMapped(mapped, { occurredAt: 't0' })).not.toHaveProperty('deliveryId');
  });
});
