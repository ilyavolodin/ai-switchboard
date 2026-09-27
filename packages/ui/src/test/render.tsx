/* eslint-disable react-refresh/only-export-components -- test helpers are never hot-reloaded */
/**
 * Test helpers: render a component (or the whole app at a path) with the query client, toasts,
 * reason prompt, a session with the given role, a memory router, and the mock API as `fetch`.
 */
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
import { type Session, SessionContext } from '../app/session.js';

import { TEST_NOW } from './constants.js';

export { TEST_NOW };

export interface RenderOptions {
  role?: Role | null;
  path?: string;
  /** Extra route pattern for the component (so `useParams` works), default `*`. */
  routePath?: string;
  overrides?: MockHandlers;
  fixtures?: Fixtures;
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

function installApi(options: RenderOptions): MockApi {
  const api = createMockApi({
    fixtures: options.fixtures ?? buildFixtures(TEST_NOW),
    overrides: options.overrides,
  });
  vi.stubGlobal('fetch', api.fetch);
  return api;
}

/** Renders one component inside providers and a memory router. */
export function renderWithProviders(ui: ReactElement, options: RenderOptions = {}): Rendered {
  const api = installApi(options);
  const role = options.role === undefined ? 'operator' : options.role;
  const session: Session = {
    user: role ? { ...api.fixtures.user, role } : null,
    authMode: 'local',
    oidcConfigured: false,
    evaluation: true,
  };
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

/** Renders the whole app (shell + route table) at `path`. */
export function renderApp(path: string, options: RenderOptions = {}): Rendered {
  const api = installApi(options);
  if (options.role !== undefined && !options.overrides?.['GET /auth/me']) {
    const me = api.fixtures.me;
    api.use({
      'GET /auth/me': () => ({
        ...me,
        user: options.role ? { ...me.user, role: options.role } : null,
      }),
    });
  }
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const user = userEvent.setup();
  const result = render(
    <AppProviders client={testClient()}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...result, api, user, router };
}
