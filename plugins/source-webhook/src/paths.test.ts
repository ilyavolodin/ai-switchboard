import { describe, expect, it } from 'vitest';

import { describeValue, isDeliveryPath, readPath, scalarText, type DeliveryView } from './paths.js';

const view: DeliveryView = {
  body: {
    id: 7,
    issue: { id: 'ISS-1', labels: [{ name: 'bug' }, { name: 'p1' }, {}], tags: ['a', 'b'] },
    'odd-key': true,
    empty: null,
  },
  headers: { 'x-github-event': 'push' },
  query: { env: 'staging' },
};

describe('delivery paths', () => {
  it.each([
    ['body.id', 7],
    ['body.issue.id', 'ISS-1'],
    ['body.issue.tags.1', 'b'],
    ['body.issue.labels.name', ['bug', 'p1']],
    ['body.odd-key', true],
    ['headers.x-github-event', 'push'],
    ['headers.X-GitHub-Event', 'push'],
    ['query.env', 'staging'],
    ['body.missing', undefined],
    ['body.empty', undefined],
    ['body.issue.id.deeper', undefined],
    ['body.issue.tags.9', undefined],
    ['body.constructor', undefined],
    ['nope.id', undefined],
    ['body..id', undefined],
  ])('%s reads %j', (path, expected) => {
    expect(readPath(view, path)).toEqual(expected);
  });

  it('validates the path shape', () => {
    expect(isDeliveryPath('body')).toBe(true);
    expect(isDeliveryPath('headers.x-event')).toBe(true);
    expect(isDeliveryPath('body.a b')).toBe(false);
    expect(isDeliveryPath('issue.id')).toBe(false);
  });

  it('describes values briefly and reads scalars as text', () => {
    expect(describeValue(undefined)).toBe('nothing');
    expect(describeValue('x'.repeat(100))).toHaveLength(58);
    expect(scalarText(42)).toBe('42');
    expect(scalarText('')).toBeUndefined();
    expect(scalarText({})).toBeUndefined();
  });
});
