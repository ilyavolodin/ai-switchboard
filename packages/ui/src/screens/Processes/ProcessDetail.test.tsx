import type { FunnelResponse } from '@ai-switchboard/core/contract';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildFixtures } from '../../api/fixtures.js';
import { TEST_NOW } from '../../test/constants.js';
import { renderWithProviders } from '../../test/render.js';
import { ProcessDetail } from './ProcessDetail.js';

const at = (tab?: string) => ({
  path: tab ? `/processes/p-autofix/${tab}` : '/processes/p-autofix',
  routePath: tab ? '/processes/:id/:tab' : '/processes/:id',
});

async function confirmWithReason(
  user: ReturnType<typeof renderWithProviders>['user'],
  reason: string,
  confirm: string,
) {
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), reason);
  await user.click(within(dialog).getByRole('button', { name: confirm }));
  return dialog;
}

describe('ProcessDetail', () => {
  it('shows the header, breaker and the pipeline for the week', async () => {
    renderWithProviders(<ProcessDetail />, at());
    expect(await screen.findByRole('heading', { name: 'Autofix' })).toBeInTheDocument();
    expect(screen.getAllByText('breaker open').length).toBeGreaterThan(0);
    expect(screen.getByText('Breaker open')).toBeInTheDocument();
    expect(screen.getByText(/next sweep/)).toBeInTheDocument();
    expect(await screen.findByRole('figure', { name: /^Pipeline:/ })).toBeInTheDocument();
    expect(screen.getByText('Pipeline · 7 d')).toBeInTheDocument();
    expect(
      await screen.findByRole('img', { name: /Runs and throttles per day/ }),
    ).toBeInTheDocument();
  });

  it('switches the funnel window', async () => {
    const f = buildFixtures(TEST_NOW);
    const windows: (string | null)[] = [];
    const { user } = renderWithProviders(<ProcessDetail />, {
      ...at(),
      overrides: {
        'GET /processes/:id/funnel': (r): FunnelResponse => {
          const w = r.query.get('window');
          windows.push(w);
          return w === '24h'
            ? {
                ...f.funnel,
                window: '24h',
                event: { ...f.funnel.event, received: 31, matched: 27 },
              }
            : f.funnel;
        },
      },
    });
    const before = await screen.findByRole('figure', { name: /^Pipeline:/ });
    const label7d = before.getAttribute('aria-label');
    await user.click(screen.getByRole('radio', { name: '24 h' }));
    expect(await screen.findByText('Pipeline · 24 h')).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(
        screen.getByRole('figure', { name: /^Pipeline:/ }).getAttribute('aria-label'),
      ).not.toBe(label7d);
    });
    expect(windows).toEqual(['7d', '24h']);
  });

  it('confirms what stops before disabling', async () => {
    const { api, user } = renderWithProviders(<ProcessDetail />, at());
    await user.click(await screen.findByRole('switch', { name: 'Enabled' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Disable Autofix?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /Disabling Autofix stops its 1 trigger and 1 sweep: no new runs start/,
      ),
    ).toBeInTheDocument();
    await confirmWithReason(user, 'pausing for the release', 'Disable Autofix');
    await vi.waitFor(() => {
      expect(api.callsTo('POST /processes/p-autofix/enable')[0]?.body).toEqual({
        enabled: false,
        reason: 'pausing for the release',
      });
    });
  });

  it('asks only for an optional note before disabling when reasons are optional', async () => {
    const { api, user } = renderWithProviders(<ProcessDetail />, {
      ...at(),
      requireReasons: false,
    });
    await user.click(await screen.findByRole('switch', { name: 'Enabled' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disable Autofix?' });
    expect(within(dialog).getByRole('textbox', { name: /Note \(optional\)/ })).not.toBeRequired();
    await user.click(within(dialog).getByRole('button', { name: 'Disable Autofix' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /processes/p-autofix/enable')[0]?.body).toEqual({
        enabled: false,
        reason: '',
      });
    });
  });

  it('resets the breaker with a reason', async () => {
    const { api, user } = renderWithProviders(<ProcessDetail />, at());
    await screen.findByText('Breaker open');
    await user.click(screen.getByRole('button', { name: 'Reset breaker' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Reset the Autofix breaker?')).toBeInTheDocument();
    await confirmWithReason(user, 'fixed the flaky suite', 'Reset breaker');
    await vi.waitFor(() => {
      expect(api.callsTo('POST /processes/p-autofix/breaker/reset')[0]?.body).toEqual({
        reason: 'fixed the flaky suite',
      });
    });
  });

  it('runs now with a reason', async () => {
    const { api, user } = renderWithProviders(<ProcessDetail />, at());
    await user.click(await screen.findByRole('button', { name: 'Run now' }));
    await confirmWithReason(user, 'retry after the fix', 'Run now');
    await vi.waitFor(() => {
      expect(api.callsTo('POST /processes/p-autofix/run')[0]?.body).toEqual({
        reason: 'retry after the fix',
      });
    });
  });

  it('deletes with a confirm naming the consequences, then goes to the list', async () => {
    const { api, user, router } = renderWithProviders(<ProcessDetail />, at());
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete Autofix?')).toBeInTheDocument();
    expect(within(dialog).getByText(/Its open batches are dropped/)).toBeInTheDocument();
    expect(within(dialog).getByText(/runs and events stay for the trace/)).toBeInTheDocument();
    await confirmWithReason(user, 'replaced by Autofix v2', 'Delete Autofix');
    await vi.waitFor(() => {
      expect(api.callsTo('DELETE /processes/p-autofix')[0]?.body).toEqual({
        reason: 'replaced by Autofix v2',
      });
    });
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/processes');
    });
    expect(await screen.findByText('Autofix deleted')).toBeInTheDocument();
  });

  it('stays on the process when the delete is cancelled', async () => {
    const { api, user, router } = renderWithProviders(<ProcessDetail />, at());
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.callsTo('DELETE /processes/p-autofix')).toHaveLength(0);
    expect(router.state.location.pathname).toBe('/processes/p-autofix');
  });

  it('keeps Run now and the toggle visible but disabled for viewers', async () => {
    renderWithProviders(<ProcessDetail />, { ...at(), role: 'viewer' });
    expect(await screen.findByRole('button', { name: 'Run now' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('switch', { name: 'Enabled' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Reset breaker' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('lists activity with links to each artifact’s trace', async () => {
    renderWithProviders(<ProcessDetail />, at());
    const list = await screen.findByRole('list', { name: 'Process activity' });
    const links = within(list).getAllByRole('link', { name: /^Trace / });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]?.getAttribute('href')).toMatch(/^\/activity\/trace\//);
    expect(within(list).getAllByRole('img', { name: /reached/ }).length).toBe(links.length);
  });

  it('settles an uncertain run from its drawer with a reason', async () => {
    const f = buildFixtures(TEST_NOW);
    const uncertain = {
      ...f.runDetail,
      status: 'uncertain' as const,
      statusLabel: { tone: 'warn' as const, label: 'uncertain' },
    };
    const { user, api } = renderWithProviders(<ProcessDetail />, {
      ...at('runs'),
      fixtures: f,
      overrides: { 'GET /runs/:id': () => uncertain },
    });
    const table = await screen.findByRole('table', { name: 'Runs of this process' });
    await user.click(within(table).getByRole('button', { name: 'Details for run run_01J8KQ4C3' }));
    const drawer = await screen.findByRole('dialog', { name: /Run run_01J8KQ4C3/ });
    const settle = await within(drawer).findByRole('region', { name: 'Settle this run' });
    await user.click(within(settle).getByRole('button', { name: 'Mark error' }));
    const prompt = await screen.findByRole('dialog', { name: 'Settle the run as error?' });
    await user.type(within(prompt).getByRole('textbox', { name: /Reason/ }), 'routine crashed');
    await user.click(within(prompt).getByRole('button', { name: 'Mark error' }));
    await vi.waitFor(() => {
      expect(api.callsTo(`POST /runs/${uncertain.id}/close`)[0]?.body).toEqual({
        status: 'error',
        reason: 'routine crashed',
      });
    });
  });

  it('offers settling only for uncertain runs, and not to viewers', async () => {
    const f = buildFixtures(TEST_NOW);
    const uncertain = { ...f.runDetail, status: 'uncertain' as const };
    const { user } = renderWithProviders(<ProcessDetail />, {
      ...at('runs'),
      role: 'viewer',
      overrides: { 'GET /runs/:id': () => uncertain },
    });
    const table = await screen.findByRole('table', { name: 'Runs of this process' });
    await user.click(within(table).getByRole('button', { name: 'Details for run run_01J8KQ4C3' }));
    const drawer = await screen.findByRole('dialog', { name: /Run run_01J8KQ4C3/ });
    const settle = await within(drawer).findByRole('region', { name: 'Settle this run' });
    for (const name of ['Mark ok', 'Mark error', 'Mark unknown']) {
      expect(within(settle).getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('shows runs in a table and opens one in a drawer', async () => {
    const { user } = renderWithProviders(<ProcessDetail />, at('runs'));
    const table = await screen.findByRole('table', { name: 'Runs of this process' });
    const external = within(table).getAllByRole('link', { name: /^Open run .* \(new tab\)$/ });
    expect(external[0]).toHaveAttribute('target', '_blank');
    expect(external[0]).toHaveAttribute('rel', 'noreferrer');
    await user.click(within(table).getByRole('button', { name: 'Details for run run_01J8KQ4C3' }));
    const drawer = await screen.findByRole('dialog', { name: /Run run_01J8KQ4C3/ });
    expect(
      (await within(drawer).findAllByText('test suite timed out (vitest, packages/engine)')).length,
    ).toBeGreaterThan(0);
    expect(within(drawer).getByRole('region', { name: 'Steps' })).toHaveTextContent(
      'src-linear.addLabel',
    );
    const steps = within(drawer).getByRole('region', { name: 'Steps' });
    expect(steps).toHaveTextContent('src-linear.comment');
    expect(within(steps).getByText('in doubt')).toBeInTheDocument();
    expect(within(drawer).getByLabelText('Run input')).toHaveTextContent('LOL-1712');
    expect(within(drawer).queryByRole('region', { name: 'Settle this run' })).toBeNull();
  });

  it('renders the definition read-only with an Edit link', async () => {
    renderWithProviders(<ProcessDetail />, at('definition'));
    expect(
      await screen.findByText("Linear issue labelled autofix where it's complexity:simple"),
    ).toBeInTheDocument();
    const edit = screen.getAllByRole('link', { name: 'Edit' });
    expect(edit.every((a) => a.getAttribute('href') === '/processes/p-autofix/edit')).toBe(true);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('diffs a version against the one before and restores it with a reason', async () => {
    const { api, user } = renderWithProviders(<ProcessDetail />, at('history'));
    const versions = await screen.findByRole('list', { name: 'Versions' });
    const diff = await screen.findByRole('table', { name: /from version 11 to version 12/ });
    const row = within(diff).getByRole('rowheader', { name: 'runs per hour' }).closest('tr');
    expect(row).toHaveTextContent('runs per hour42');

    await user.click(within(versions).getByRole('button', { name: /^version 11/ }));
    expect(
      await screen.findByRole('table', { name: /from version 10 to version 11/ }),
    ).toHaveTextContent('quiet hours');

    expect(within(versions).queryByRole('button', { name: 'Restore version 12' })).toBeNull();
    await user.click(within(versions).getByRole('button', { name: 'Restore version 11' }));
    await confirmWithReason(user, 'the 2/h cap starved the queue', 'Restore');
    await vi.waitFor(() => {
      expect(api.callsTo('POST /processes/p-autofix/versions/11/restore')[0]?.body).toEqual({
        reason: 'the 2/h cap starved the queue',
      });
    });
  });

  it('says so when the process does not exist', async () => {
    renderWithProviders(<ProcessDetail />, {
      path: '/processes/nope',
      routePath: '/processes/:id',
    });
    expect(await screen.findByText('This process does not exist')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All processes' })).toHaveAttribute(
      'href',
      '/processes',
    );
  });
});
