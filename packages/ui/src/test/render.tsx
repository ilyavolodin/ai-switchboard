/* eslint-disable react-refresh/only-export-components -- test helpers are never hot-reloaded */
import type { Role } from '@ai-switchboard/core/contract';
import { QueryClient } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { vi } from 'vitest';

import { buildFixtures, type Fixtures } from '../api/fixtures.js';
import { createMockApi, type MockApi, type MockHandlers } from '../api/mockApi.js';
import { AppProviders } from '../app/AppProviders.js';
import { routes } from '../app/routes.js';
import { SessionContext, sessionFromMe } from '../app/session.js';

import { TEST_NOW } from './constants.js';

export { TEST_NOW };

export interface RenderOptions {
  role?: Role | null;
  path?: string;
  /** So `useParams` works; default `*`. */
  routePath?: string;
  overrides?: MockHandlers;
  fixtures?: Fixtures;
  requireReasons?: boolean;
}

export interface Rendered extends RenderResult {
  api: MockApi;
  user: ReturnType<typeof userEvent.setup>;
  router: ReturnType<typeof createMemoryRouter>;
}

function testClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

/** `role` and `requireReasons` are written into `fixtures.me`, the one source of the session. */
function installApi(options: RenderOptions, defaultRole: Role | null | undefined): MockApi {
  const fixtures = options.fixtures ?? buildFixtures(TEST_NOW);
  const role = options.role === undefined ? defaultRole : options.role;
  if (options.requireReasons === false) {
    fixtures.settings = { ...fixtures.settings, requireReasons: false };
  }
  fixtures.me = {
    ...fixtures.me,
    requireReasons: options.requireReasons ?? fixtures.me.requireReasons,
    ...(role !== undefined
      ? { user: role && fixtures.me.user ? { ...fixtures.me.user, role } : null }
      : {}),
  };
  const api = createMockApi({ fixtures, overrides: options.overrides });
  vi.stubGlobal('fetch', api.fetch);
  return api;
}

export function renderWithProviders(ui: ReactElement, options: RenderOptions = {}): Rendered {
  const api = installApi(options, 'operator');
  const session = sessionFromMe(api.fixtures.me);
  const router = createMemoryRouter(
    [
      {
        path: options.routePath ?? '*',
        element: <SessionContext.Provider value={session}>{ui}</SessionContext.Provider>,
      },
    ],
    { initialEntries: [options.path ?? '/'] },
  );
  const user = userEvent.setup();
  const result = render(
    <AppProviders client={testClient()}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...result, api, user, router };
}

export function renderApp(path: string, options: RenderOptions = {}): Rendered {
  const api = installApi(options, undefined);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const user = userEvent.setup();
  const result = render(
    <AppProviders client={testClient()}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...result, api, user, router };
}
