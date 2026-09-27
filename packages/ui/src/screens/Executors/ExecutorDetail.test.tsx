import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildFixtures } from '../../api/fixtures.js';
import { at } from '../../lib/at.js';
import { TEST_NOW } from '../../test/constants.js';
import type { RenderOptions } from '../../test/render.js';
import { renderWithProviders } from '../../test/render.js';
import { ExecutorDetail } from './ExecutorDetail.js';

function renderExecutor(path: string, options: RenderOptions = {}) {
  const routePath = path.split('/').length > 3 ? '/executors/:id/:tab' : '/executors/:id';
  return renderWithProviders(<ExecutorDetail />, { path, routePath, ...options });
}

async function reasonAndConfirm(
  user: ReturnType<typeof renderExecutor>['user'],
  reason: string,
  confirm: string,
) {
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), reason);
  await user.click(within(dialog).getByRole('button', { name: confirm }));
}

describe('ExecutorDetail', () => {
  it('draws the meters, the meter band with run markers and usage per dimension with its unit', async () => {
    const { container, user } = renderExecutor('/executors/ex-routines');
    expect(
      await screen.findByRole('heading', { name: 'Claude Routines — automation seat', level: 1 }),
    ).toBeVisible();
    const now = screen.getByRole('list', { name: 'Meters now' });
    expect(within(now).getAllByRole('listitem')).toHaveLength(3);

    const band = await screen.findByRole('img', {
      name: /^Meter history over 7 d with \d+ run markers/,
    });
    expect(band.querySelectorAll('[data-part="band"]')).toHaveLength(2);
    expect(band.querySelectorAll('[data-part="run"]').length).toBeGreaterThan(0);
    // Run markers name their process; the picker highlights one process's runs.
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Highlight a process' }),
      'p-autofix',
    );
    expect(screen.getByRole('combobox', { name: 'Highlight a process' })).toHaveValue('p-autofix');
    expect(container.querySelector('[data-part="run"] title')).toHaveTextContent(/^Autofix · /);

    expect(await screen.findByRole('heading', { name: 'Input tokens' })).toBeInTheDocument();
    expect(screen.getByText('tokens · per day')).toBeInTheDocument();
    expect(screen.getByText('seconds · per day')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Input tokens per day over 7 d, in tokens' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Duration per day over 7 d, in seconds' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /^Runs by status: \d+ ok, 3 error$/ }),
    ).toBeInTheDocument();
  });

  it('reads meters now and reloads, each with a reason', async () => {
    const { user, api } = renderExecutor('/executors/ex-routines');
    await user.click(await screen.findByRole('button', { name: 'Read meters now' }));
    await reasonAndConfirm(user, 'window just reset', 'Read meters');
    await vi.waitFor(() => {
      expect(api.callsTo('POST /executors/ex-routines/meters/read')[0]?.body).toEqual({
        reason: 'window just reset',
      });
    });
    expect(await screen.findByText('Read 3 meters')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await reasonAndConfirm(user, 'new key', 'Reload');
    await vi.waitFor(() => {
      expect(api.callsTo('POST /executors/ex-routines/reload')).toHaveLength(1);
    });
  });

  it('shows a soft hold and clears it with a reason', async () => {
    const f = buildFixtures(TEST_NOW);
    const held = {
      ...f.executorDetail(at(f.executors, 0)),
      softHoldUntil: new Date(TEST_NOW + 30 * 60_000).toISOString(),
      softHoldReason: 'The backend answered 429.',
    };
    const { user, api } = renderExecutor('/executors/ex-routines', {
      overrides: { 'GET /executors/:id': () => held },
    });
    expect(await screen.findByText(/The backend answered 429/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear soft hold' }));
    await reasonAndConfirm(user, 'confirmed with the vendor', 'Clear soft hold');
    await vi.waitFor(() => {
      expect(api.callsTo('POST /executors/ex-routines/soft-hold/clear')[0]?.body).toEqual({
        reason: 'confirmed with the vendor',
      });
    });
  });

  it('lists runs with external links that open in a new tab', async () => {
    renderExecutor('/executors/ex-routines/runs');
    const table = await screen.findByRole('table', {
      name: 'Runs on Claude Routines — automation seat',
    });
    const rows = within(table).getAllByRole('row');
    expect(rows.length).toBeGreaterThan(1);
    const link = within(table).getAllByRole('link', { name: /session_/ })[0];
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('saves caps including usage per day and staleness', async () => {
    const { user, api } = renderExecutor('/executors/ex-routines/settings');
    const tokens = await screen.findByLabelText('Input tokens per day');
    await user.type(tokens, '500000');
    const stale = screen.getByLabelText('Meter staleness');
    await user.clear(stale);
    await user.type(stale, '30');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await reasonAndConfirm(user, 'tighter budget', 'Save changes');
    await vi.waitFor(() => {
      expect(api.callsTo('PUT /executors/ex-routines')).toHaveLength(1);
    });
    expect(api.callsTo('PUT /executors/ex-routines')[0]?.body).toMatchObject({
      reason: 'tighter budget',
      settings: { orgId: 'org_lola', apiKey: 'secret://env/CLAUDE_API_KEY' },
      caps: {
        runsPerDay: 22,
        usagePerDay: { input_tokens: 500000 },
        meterStalenessMinutes: 30,
      },
    });
  });

  it('keeps actions visible but disabled for viewers', async () => {
    renderExecutor('/executors/ex-routines', { role: 'viewer' });
    for (const name of ['Read meters now', 'Reload']) {
      expect(await screen.findByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    }
    expect(screen.getByRole('switch', { name: 'Enabled' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
