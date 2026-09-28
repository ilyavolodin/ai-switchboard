import { describe, expect, it } from 'vitest';

import {
  deliverySample,
  draftFromDelivery,
  EMPTY_SAMPLE,
  headerLines,
  previewRequest,
  queryParams,
} from './sampleDelivery.js';

describe('sample deliveries', () => {
  it('reads header lines and query strings', () => {
    expect(headerLines('X-Event-Type: issue.created\nbad line\n: nothing\nx-a:  b:c ')).toEqual({
      'x-event-type': 'issue.created',
      'x-a': 'b:c',
    });
    expect(queryParams('?env=staging&x=1')).toEqual({ env: 'staging', x: '1' });
  });

  it('builds the path sample and the preview request only once there is a body', () => {
    expect(deliverySample(EMPTY_SAMPLE)).toBeNull();
    expect(previewRequest('webhook', {}, undefined, EMPTY_SAMPLE)).toBeNull();
    const draft = { body: '{"id": 1}', headers: 'x-a: 1', query: '' };
    expect(deliverySample(draft)).toEqual({ body: { id: 1 }, headers: { 'x-a': '1' }, query: {} });
    expect(previewRequest('webhook', { a: 1 }, 'src-1', draft)).toEqual({
      typeId: 'webhook',
      settings: { a: 1 },
      sourceId: 'src-1',
      request: { body: '{"id": 1}', headers: { 'x-a': '1' } },
    });
  });

  it('turns a stored delivery into panel text, pretty-printing JSON', () => {
    expect(
      draftFromDelivery({
        receivedAt: '2026-09-27T10:00:00Z',
        body: '{"id":1}',
        headers: { 'x-a': '1', 'x-signature': '[redacted]' },
      }),
    ).toEqual({ body: '{\n  "id": 1\n}', headers: 'x-a: 1\nx-signature: [redacted]', query: '' });
  });
});
