import Fastify from 'fastify';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { FakeClock } from '../../clock.js';
import { testConfig } from '../../config.js';
import type { ApiContext } from '../context.js';
import type { ApiRoute, ApiRoutes, RouteShape } from '../contract.js';
import { registerApiRoutes } from './index.js';

/** `satisfies` fails to compile when a route is missing from, or not in, `ApiRoutes`. */
const CONTRACT = {
  'DELETE /api/v1/destinations/:id': true,
  'DELETE /api/v1/notifiers/:id': true,
  'DELETE /api/v1/plugins/:name': true,
  'DELETE /api/v1/processes/:id': true,
  'DELETE /api/v1/secret-providers/:id': true,
  'DELETE /api/v1/sources/:id': true,
  'DELETE /api/v1/tokens/:id': true,
  'DELETE /api/v1/users/:id': true,
  'DELETE /api/v1/users/:id/password': true,
  'GET /api/v1/about': true,
  'GET /api/v1/approvals': true,
  'GET /api/v1/approvals/history': true,
  'GET /api/v1/approvals/rules': true,
  'GET /api/v1/audit': true,
  'GET /api/v1/auth/me': true,
  'GET /api/v1/auth/oidc/callback': true,
  'GET /api/v1/auth/oidc/start': true,
  'GET /api/v1/auth/whoami': true,
  'GET /api/v1/board': true,
  'GET /api/v1/destinations': true,
  'GET /api/v1/destinations/:id': true,
  'GET /api/v1/destinations/:id/meters': true,
  'GET /api/v1/destinations/:id/usage': true,
  'GET /api/v1/events': true,
  'GET /api/v1/events/:id': true,
  'GET /api/v1/events/:id/trace': true,
  'GET /api/v1/export': true,
  'GET /api/v1/notifiers': true,
  'GET /api/v1/plugin-types': true,
  'GET /api/v1/plugins': true,
  'GET /api/v1/plugins/catalogue': true,
  'GET /api/v1/plugins/search': true,
  'GET /api/v1/processes': true,
  'GET /api/v1/processes/:id': true,
  'GET /api/v1/processes/:id/activity': true,
  'GET /api/v1/processes/:id/batches': true,
  'GET /api/v1/processes/:id/funnel': true,
  'GET /api/v1/processes/:id/stats': true,
  'GET /api/v1/processes/:id/versions': true,
  'GET /api/v1/processes/:id/versions/:version': true,
  'GET /api/v1/runs': true,
  'GET /api/v1/runs/:id': true,
  'GET /api/v1/secret-providers': true,
  'GET /api/v1/secret-providers/:id/secrets': true,
  'GET /api/v1/settings': true,
  'GET /api/v1/sources': true,
  'GET /api/v1/sources/:id': true,
  'GET /api/v1/sources/:id/events': true,
  'GET /api/v1/sources/:id/last-delivery': true,
  'GET /api/v1/sources/:id/stats': true,
  'GET /api/v1/status': true,
  'GET /api/v1/tokens': true,
  'GET /api/v1/trace': true,
  'GET /api/v1/users': true,
  'GET /api/v1/users/directory': true,
  'POST /api/v1/apply': true,
  'POST /api/v1/approvals/:batchId/approve': true,
  'POST /api/v1/approvals/:batchId/reject': true,
  'POST /api/v1/auth/login': true,
  'POST /api/v1/auth/logout': true,
  'POST /api/v1/auth/password': true,
  'POST /api/v1/destinations': true,
  'POST /api/v1/destinations/:id/enable': true,
  'POST /api/v1/destinations/:id/meters/read': true,
  'POST /api/v1/destinations/:id/reload': true,
  'POST /api/v1/destinations/:id/soft-hold/clear': true,
  'POST /api/v1/events/:id/replay': true,
  'POST /api/v1/notifiers': true,
  'POST /api/v1/notifiers/:id/enable': true,
  'POST /api/v1/notifiers/:id/reload': true,
  'POST /api/v1/notifiers/:id/test': true,
  'POST /api/v1/plugins': true,
  'POST /api/v1/plugins/inspect': true,
  'POST /api/v1/processes': true,
  'POST /api/v1/processes/:id/breaker/reset': true,
  'POST /api/v1/processes/:id/enable': true,
  'POST /api/v1/processes/:id/run': true,
  'POST /api/v1/processes/:id/versions/:version/restore': true,
  'POST /api/v1/processes/preview/cron': true,
  'POST /api/v1/processes/preview/filter': true,
  'POST /api/v1/processes/preview/input': true,
  'POST /api/v1/runs/:id/close': true,
  'POST /api/v1/secret-providers': true,
  'POST /api/v1/secret-providers/:id/enable': true,
  'POST /api/v1/secret-providers/:id/reload': true,
  'POST /api/v1/sources': true,
  'POST /api/v1/sources/:id/enable': true,
  'POST /api/v1/sources/:id/provision': true,
  'POST /api/v1/sources/:id/reload': true,
  'POST /api/v1/sources/:id/test-event': true,
  'POST /api/v1/sources/preview': true,
  'POST /api/v1/tokens': true,
  'POST /api/v1/users': true,
  'POST /api/v1/users/:id/sessions/revoke': true,
  'PUT /api/v1/destinations/:id': true,
  'PUT /api/v1/notifiers/:id': true,
  'PUT /api/v1/processes/:id': true,
  'PUT /api/v1/secret-providers/:id': true,
  'PUT /api/v1/settings': true,
  'PUT /api/v1/sources/:id': true,
  'PUT /api/v1/users/:id': true,
  'PUT /api/v1/users/:id/password': true,
} satisfies Record<ApiRoute, true>;

async function registeredRoutes(): Promise<string[]> {
  const app = Fastify();
  const seen: string[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') seen.push(`${method} ${route.url}`);
    }
  });
  // Registering routes touches no dependency; handlers are never called here.
  const ctx = { db: {}, clock: new FakeClock(), config: testConfig() } as unknown as ApiContext;
  registerApiRoutes(app, ctx);
  await app.ready();
  await app.close();
  return seen.sort();
}

describe('ApiRoutes', () => {
  it('gives every route a body, query and response shape', () => {
    expectTypeOf<ApiRoutes>().toExtend<Record<ApiRoute, RouteShape>>();
  });

  it('lists exactly the routes the server registers', async () => {
    expect(await registeredRoutes()).toEqual(Object.keys(CONTRACT).sort());
  });
});
