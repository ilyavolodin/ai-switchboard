import { describe, expect, it } from 'vitest';

import { rewriteLegacyUrl } from './legacy.js';

describe('rewriteLegacyUrl (deprecated executor aliases)', () => {
  it.each([
    ['/api/v1/executors', '/api/v1/destinations'],
    ['/api/v1/executors/abc', '/api/v1/destinations/abc'],
    ['/api/v1/executors/abc/meters/read', '/api/v1/destinations/abc/meters/read'],
    ['/api/v1/executors?x=1', '/api/v1/destinations?x=1'],
    ['/api/v1/plugin-types?kind=executor', '/api/v1/plugin-types?kind=destination'],
    ['/api/v1/plugins/search?q=n8n&kind=executor', '/api/v1/plugins/search?q=n8n&kind=destination'],
    ['/api/v1/runs?executor=abc&status=ok', '/api/v1/runs?destination=abc&status=ok'],
    ['/api/v1/events?executor=abc', '/api/v1/events?destination=abc'],
  ])('rewrites %s', (from, to) => {
    expect(rewriteLegacyUrl(from)).toBe(to);
  });

  it.each([
    '/api/v1/destinations/abc',
    '/api/v1/executorsx',
    '/api/v1/plugin-types?kind=source',
    '/api/v1/runs?destination=new&executor=old',
    '/callbacks/abc',
    '/executors',
    '/api/v1/runs?',
  ])('leaves %s alone', (url) => {
    expect(rewriteLegacyUrl(url)).toBe(url);
  });
});
