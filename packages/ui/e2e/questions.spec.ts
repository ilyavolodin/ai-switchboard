/**
 * The four questions the UI exists to answer (TDD, Testing › UI), against the real stack:
 * see a breaker on the Board, find an artifact's trace by id, read a meter, and edit a process
 * then find the change in the audit log.
 */
import type { ProcessDetail } from '@ai-switchboard/core/contract';

import { expect, open, test } from './fixtures.js';
import { BREAKER_PROCESS, DESTINATION, HEALTHY_PROCESS } from './seed.js';
import { sendAlert, waitFor } from './stack.js';

test('the Board shows an open breaker, and Reset closes it', async ({ page, api, state }) => {
  await open(page, '/');
  const node = page.getByRole('link', {
    name: `Process ${BREAKER_PROCESS}, breaker open, no sweep`,
  });
  await expect(node).toBeVisible();
  // The node's border carries the error tone; its label says it in words.
  await expect(node).toHaveAttribute('data-tone', 'error');

  const attention = page.getByRole('region', { name: 'Needs attention' });
  const reset = attention.getByRole('button', { name: `Reset: ${BREAKER_PROCESS}: breaker open` });
  await expect(reset).toBeVisible();
  await expect(page.getByRole('link', { name: '1 breaker open' })).toBeVisible();

  await reset.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /Reason/ }).fill('e2e: the stub is fixed');
  await dialog.getByRole('button', { name: 'Reset breaker' }).click();

  await expect(
    page.getByRole('link', { name: new RegExp(`^Process ${BREAKER_PROCESS}, `) }),
  ).not.toHaveAccessibleName(/breaker open/);
  await expect(reset).toBeHidden();
  const detail = await api.get<ProcessDetail>(`/api/v1/processes/${state.breakerProcessId}`);
  expect(detail.breakerState).toBe('closed');

  // Leave the stack as seeded: one more failing alert opens the breaker again.
  await sendAlert(state.stubUrl, state.baseUrl, state.sourceId, 'breaker');
  await waitFor('the breaker to open again', async () => {
    const d = await api.get<ProcessDetail>(`/api/v1/processes/${state.breakerProcessId}`);
    return d.breakerState === 'open' ? true : undefined;
  });
});

test("`/` then an artifact id opens the artifact's trace", async ({ page, state }) => {
  await open(page, '/');
  await page.keyboard.press('/');
  const search = page.getByRole('searchbox', { name: 'Search by artifact id' });
  await expect(search).toBeFocused();
  await search.fill(state.artifactId);
  await search.press('Enter');

  await expect(page).toHaveURL(new RegExp(`/activity/trace/${state.artifactId}$`));
  const timeline = page.getByRole('list', { name: 'Trace timeline' });
  await expect(timeline.getByText('Filter matched')).toBeVisible();
  await expect(timeline.getByText('Gate breaker_closed: pass')).toBeVisible();
  await expect(timeline.getByText('Budget: within limits')).toBeVisible();
  await expect(timeline.getByText(`Invoked ${DESTINATION}`)).toBeVisible();
  await expect(timeline.getByRole('link', { name: HEALTHY_PROCESS }).first()).toBeVisible();
});

test('the destination shows its meter with a value and a reset countdown, and so does the top bar', async ({
  page,
  state,
}) => {
  await open(page, `/destinations/${state.destinationId}`);
  const meters = page.getByRole('list', { name: 'Meters now' });
  const gauge = meters.getByRole('img', { name: /^Endpoint capacity 30% used/ });
  await expect(gauge).toBeVisible();
  await expect(gauge).toHaveAccessibleName(/resets in \d+ h \d+ m/);
  await expect(meters.getByText('30%')).toBeVisible();
  await expect(meters.getByText(/resets in/)).toBeVisible();

  const strip = page.getByLabel('Destination capacity');
  const link = strip.getByRole('link', { name: /Stub HTTP · Endpoint capacity 30%.*resets in/ });
  await expect(link).toBeVisible();
  await expect(link).toContainText('30%');
  await expect(link).toContainText(/\dh\d+m/);
});

test('an edit to a process is in the audit log with its reason', async ({ page, api, state }) => {
  const before = await api.get<ProcessDetail>(`/api/v1/processes/${state.healthyProcessId}`);
  const next = (before.document.budgets.runsPerHour ?? 30) + 1;
  const reason = `e2e: raise the hourly budget to ${next}`;

  await open(page, `/processes/${state.healthyProcessId}/edit`);
  await page.getByRole('button', { name: /^Budgets/ }).click();
  const field = page.getByRole('textbox', { name: 'Runs per hour' });
  await field.fill(String(next));
  const footer = page.getByRole('region', { name: 'Save changes' });
  await footer.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /Reason/ }).fill(reason);
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  // Saving returns to the process, one version on.
  await expect(page).toHaveURL(new RegExp(`/processes/${state.healthyProcessId}$`));
  await expect(page.getByRole('link', { name: `History ${before.version + 1}` })).toBeVisible();

  await open(page, '/settings/audit');
  const row = page.getByRole('row').filter({ hasText: reason });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(HEALTHY_PROCESS);
  await expect(row).toContainText('budgets.runsPerHour');
  await expect(row).toContainText(String(next));
});
