import { describe, expect, it } from 'vitest';

import { routeParamNames, routePath } from './client.js';

describe('routes', () => {
  it.each([
    ['GET /processes', [], '/processes'],
    ['POST /processes/:id/run', ['id'], '/processes/p%2F1/run'],
    ['GET /processes/:id/versions/:version', ['id', 'version'], '/processes/p%2F1/versions/3'],
    ['POST /approvals/:batchId/approve', ['batchId'], '/approvals/b-1/approve'],
  ] as const)('%s', (route, names, path) => {
    expect(routeParamNames(route)).toEqual(names);
    expect(routePath(route, { id: 'p/1', version: 3, batchId: 'b-1' })).toBe(path);
  });
});
