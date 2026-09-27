/**
 * Test fixtures for the e2e suite:
 * - `state`: the ids global setup seeded, and `api`, an admin API client for the same stack.
 * - `baseURL` points at the stack global setup started.
 * - `page` is signed in as the local admin (opt out with `test.use({ signedIn: false })`).
 * - Every test fails on an uncaught page error, a console error, or an `/api` response of 400 or
 *   more, unless the test allows it in `allowedApiErrors` (a regex over `401 POST /api/v1/…`).
 *
 * The fixture callback is named `provide`, not Playwright's usual `use`, so the React hooks lint
 * rule doesn't mistake it for `React.use`.
 */
import { expect, test as base, type Page } from '@playwright/test';

import { ADMIN_EMAIL, ADMIN_PASSWORD, Api, type StackState } from './stack.js';

interface Fixtures {
  signedIn: boolean;
  allowedApiErrors: RegExp[];
  api: Api;
  problems: string[];
}

interface WorkerFixtures {
  state: StackState;
}

function readState(): StackState {
  const raw = process.env.E2E_STATE;
  if (raw === undefined) throw new Error('E2E_STATE is not set: global setup did not run');
  return JSON.parse(raw) as StackState;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  state: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      await provide(readState());
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ state }, provide) => {
    await provide(state.baseUrl);
  },
  signedIn: [true, { option: true }],
  allowedApiErrors: [[], { option: true }],
  api: async ({ state }, provide) => {
    await provide(new Api(state.baseUrl, { token: state.token }));
  },
  problems: [
    async ({ page, allowedApiErrors }, provide) => {
      const problems: string[] = [];
      page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        // The browser logs every failed fetch; those are reported (or allowed) below.
        if (msg.text().startsWith('Failed to load resource')) return;
        problems.push(`console error: ${msg.text()}`);
      });
      page.on('response', (res) => {
        const url = new URL(res.url());
        if (!url.pathname.startsWith('/api/') || res.status() < 400) return;
        const line = `${res.status()} ${res.request().method()} ${url.pathname}${url.search}`;
        if (allowedApiErrors.some((re) => re.test(line))) return;
        problems.push(`api error: ${line}`);
      });
      await provide(problems);
      expect(problems, 'no page errors, console errors or failed API calls').toEqual([]);
    },
    { auto: true },
  ],
  page: async ({ page, signedIn }, provide) => {
    if (signedIn) {
      const res = await page.request.post('/api/v1/auth/login', {
        data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      expect(res.ok(), 'sign in').toBe(true);
    }
    await provide(page);
  },
});

export { expect };

/** Open a path and wait until the shell has rendered its top bar. */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('banner')).toBeVisible();
}
