/**
 * Every main route of the real app renders against the real API: no error state, no uncaught
 * page or console error and no failed API call (the fixtures fail the test on those). This is
 * the suite that catches UI ↔ API contract mismatches.
 */
import type { Page } from '@playwright/test';

import { expect, open, test } from './fixtures.js';

/** Error states the screens render: route errors, failed queries, unknown tabs. */
async function expectNoErrorState(page: Page): Promise<void> {
  await expect(page.getByRole('main')).toBeVisible();
  // Let the screen's queries settle before looking for an error state.
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(/something went wrong|couldn.t load|no such tab/i)).toHaveCount(0);
  // A field the UI expects but the API doesn't send renders as one of these.
  const text = await page.getByRole('main').innerText();
  expect(text).not.toMatch(/\bundefined\b|\bNaN\b|Invalid Date|\[object Object\]|\bnull\b/);
  if (process.env.E2E_SHOTS) {
    await page.screenshot({
      path: `${process.env.E2E_SHOTS}/${test.info().title.replace(/\W+/g, '_')}.png`,
      fullPage: true,
    });
  }
}

test.describe('every screen renders against the real API', () => {
  const statics: [string, string | RegExp][] = [
    ['/', 'Board'],
    ['/processes', 'Processes'],
    ['/processes/new', /New process/],
    ['/sources', 'Sources'],
    ['/executors', 'Executors'],
    ['/activity', 'Activity'],
    ['/approvals', 'Approvals'],
    ['/plugins', 'Plugins'],
    ['/plugins/browse', 'Plugins'],
  ];
  for (const [path, heading] of statics) {
    test(path, async ({ page }) => {
      await open(page, path);
      await expect(page.getByRole('heading', { level: 1, name: heading }).first()).toBeVisible();
      await expectNoErrorState(page);
    });
  }

  for (const tab of [
    '',
    '/sign-in',
    '/users',
    '/tokens',
    '/notifiers',
    '/secret-providers',
    '/retention',
    '/export',
    '/about',
    '/audit',
  ]) {
    test(`/settings${tab}`, async ({ page }) => {
      await open(page, `/settings${tab}`);
      await expectNoErrorState(page);
    });
  }

  for (const tab of ['', '/runs', '/activity', '/definition', '/history']) {
    test(`process detail${tab || ' overview'}`, async ({ page, state }) => {
      await open(page, `/processes/${state.healthyProcessId}${tab}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Healthy alerts' })).toBeVisible();
      await expectNoErrorState(page);
    });
  }

  test('process detail with an open breaker', async ({ page, state }) => {
    await open(page, `/processes/${state.breakerProcessId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Breaker demo' })).toBeVisible();
    await expectNoErrorState(page);
  });

  test('process editor', async ({ page, state }) => {
    await open(page, `/processes/${state.healthyProcessId}/edit`);
    await expect(page.getByRole('button', { name: /save/i }).first()).toBeVisible();
    await expectNoErrorState(page);
  });

  for (const tab of ['', '/settings', '/events']) {
    test(`source detail${tab || ' overview'}`, async ({ page, state }) => {
      await open(page, `/sources/${state.sourceId}${tab}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Stub alerts' })).toBeVisible();
      await expectNoErrorState(page);
    });
  }

  for (const tab of ['', '/settings', '/runs']) {
    test(`executor detail${tab || ' overview'}`, async ({ page, state }) => {
      await open(page, `/executors/${state.executorId}${tab}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Stub HTTP' })).toBeVisible();
      await expectNoErrorState(page);
    });
  }

  test('trace by artifact id', async ({ page, state }) => {
    await open(page, `/activity/trace/${state.artifactId}`);
    await expectNoErrorState(page);
  });
});
