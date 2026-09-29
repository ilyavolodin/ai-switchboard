import type { ProcessDetail, UpdateProcessRequest } from '@ai-switchboard/core/contract';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildFixtures } from '../../api/fixtures.js';
import { TEST_NOW } from '../../test/constants.js';
import { renderWithProviders } from '../../test/render.js';
import { ProcessEditor } from './ProcessEditor.js';

const editAutofix = { path: '/processes/p-autofix/edit', routePath: '/processes/:id/edit' };

function autofixWith(patch: Partial<ProcessDetail['document']>) {
  const f = buildFixtures(TEST_NOW);
  const summary = f.processes.find((p) => p.id === 'p-autofix');
  if (!summary) throw new Error('fixture Autofix missing');
  const detail = f.processDetail(summary);
  const next: ProcessDetail = { ...detail, document: { ...detail.document, ...patch } };
  return { ...editAutofix, overrides: { 'GET /processes/:id': () => next } };
}

async function open(user: ReturnType<typeof renderWithProviders>['user'], section: string) {
  await screen.findByRole('region', { name: 'Triggers' });
  await user.click(screen.getByRole('button', { name: new RegExp(`^${section}`) }));
  return screen.getByRole('region', { name: section });
}

async function savedDocument(
  user: ReturnType<typeof renderWithProviders>['user'],
  api: ReturnType<typeof renderWithProviders>['api'],
) {
  await user.click(screen.getByRole('button', { name: 'Save' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'simpler');
  await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await vi.waitFor(() => {
    expect(api.callsTo('PUT /processes/p-autofix')).toHaveLength(1);
  });
  return (api.callsTo('PUT /processes/p-autofix')[0]?.body as UpdateProcessRequest).document;
}

describe('Batch events switch', () => {
  it('is on for a batching process; off hides the fields and saves one run per event', async () => {
    const { api, user } = renderWithProviders(<ProcessEditor />, editAutofix);
    const section = await open(user, 'Batching');
    const toggle = within(section).getByRole('switch', { name: 'Batch events' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(within(section).getByRole('textbox', { name: /^Debounce/ })).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(within(section).queryByRole('textbox', { name: /^Debounce/ })).toBeNull();
    expect(within(section).queryByRole('textbox', { name: /^Max size/ })).toBeNull();
    expect(within(section).getByText(/every event is its own run, started at once/)).toBeVisible();
    expect(within(section).getByText('Off — one run per event')).toBeInTheDocument();
    const diagram = screen.getByRole('figure', { name: 'Process diagram' });
    expect(within(diagram).getByText('no batching')).toBeInTheDocument();

    const doc = await savedDocument(user, api);
    expect(doc.batching).toEqual({ debounceSeconds: 0, maxSize: 1, maxAgeSeconds: 0 });
  });

  it('switching back on restores the values it had', async () => {
    const { user } = renderWithProviders(<ProcessEditor />, editAutofix);
    const section = await open(user, 'Batching');
    const toggle = within(section).getByRole('switch', { name: 'Batch events' });
    await user.click(toggle);
    await user.click(toggle);
    expect(within(section).getByRole('textbox', { name: /^Debounce/ })).toHaveValue('90');
    expect(within(section).getByRole('textbox', { name: /^Max size/ })).toHaveValue('3');
    expect(within(section).getByRole('textbox', { name: /^Group by/ })).toHaveValue('artifact.id');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('reads max size 1 as off, and on starts from the defaults', async () => {
    const { user } = renderWithProviders(
      <ProcessEditor />,
      autofixWith({ batching: { debounceSeconds: 0, maxSize: 1, maxAgeSeconds: 0 } }),
    );
    const section = await open(user, 'Batching');
    expect(within(section).getByText('Off — one run per event')).toBeInTheDocument();
    const toggle = within(section).getByRole('switch', { name: 'Batch events' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(within(section).queryByRole('textbox', { name: /^Debounce/ })).toBeNull();
    await user.click(toggle);
    expect(within(section).getByRole('textbox', { name: /^Debounce/ })).toHaveValue('30');
    expect(within(section).getByRole('textbox', { name: /^Max size/ })).toHaveValue('20');
    expect(within(section).getByRole('textbox', { name: /^Max age/ })).toHaveValue('600');
  });
});

describe('Limit runs switch', () => {
  it('off drops every cap of the process and says the destination caps still apply', async () => {
    const { api, user } = renderWithProviders(<ProcessEditor />, editAutofix);
    const section = await open(user, 'Budgets');
    const toggle = within(section).getByRole('switch', { name: 'Limit runs' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(within(section).getByRole('textbox', { name: /^Runs per hour/ })).toHaveValue('2');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(within(section).queryByRole('textbox', { name: /^Runs per hour/ })).toBeNull();
    expect(within(section).queryByRole('list', { name: 'Meter ceilings' })).toBeNull();
    expect(within(section).getByText('No limits')).toBeInTheDocument();
    expect(within(section).getByText(/own caps still apply/)).toBeInTheDocument();

    const doc = await savedDocument(user, api);
    expect(doc.budgets).toEqual({ meterCeilings: {} });
  });

  it('reads a document without caps as off, and on starts at 20 runs per day', async () => {
    const { user } = renderWithProviders(
      <ProcessEditor />,
      autofixWith({ budgets: { meterCeilings: {} } }),
    );
    const section = await open(user, 'Budgets');
    const toggle = within(section).getByRole('switch', { name: 'Limit runs' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(within(section).getByText('No limits')).toBeInTheDocument();
    await user.click(toggle);
    expect(within(section).getByRole('textbox', { name: /^Runs per day/ })).toHaveValue('20');
    expect(within(section).getByRole('textbox', { name: /^Runs per hour/ })).toHaveValue('');
    await user.clear(within(section).getByRole('textbox', { name: /^Runs per day/ }));
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(within(section).getByRole('textbox', { name: /^Runs per day/ })).toBeInTheDocument();
  });
});
