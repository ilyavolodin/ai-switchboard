import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { mockStatus } from '../../api/mockApi.js';
import { renderWithProviders } from '../../test/render.js';
import { Processes } from './Processes.js';

const cardNames = () =>
  within(screen.getByRole('list', { name: 'Processes' }))
    .getAllByRole('link')
    .map((a) => a.getAttribute('aria-label'));

describe('Processes', () => {
  it('shows every process as a card that links to it', async () => {
    renderWithProviders(<Processes />);
    const list = await screen.findByRole('list', { name: 'Processes' });
    const cards = within(list).getAllByRole('link');
    expect(cards).toHaveLength(11);
    const autofix = within(list).getByRole('link', { name: 'Autofix · breaker open' });
    expect(autofix).toHaveAttribute('href', '/processes/p-autofix');
    expect(within(autofix).getByText('Linear → Claude Routines')).toBeInTheDocument();
    expect(within(autofix).getByRole('meter', { name: /daily cap/ })).toHaveAttribute(
      'aria-valuetext',
      '3 of 4',
    );
    expect(within(autofix).getByRole('img', { name: /^Last hour:/ })).toBeInTheDocument();
    expect(
      within(autofix).getByRole('img', { name: /^Runs per day, last 7 days/ }),
    ).toBeInTheDocument();
  });

  it('sorts by activity, status and name', async () => {
    const { user } = renderWithProviders(<Processes />);
    await screen.findByRole('list', { name: 'Processes' });
    expect(cardNames()[0]).toBe('Sizer · healthy');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'status');
    expect(cardNames()[0]).toBe('Autofix · breaker open');
    expect(cardNames().at(-1)).toMatch(/disabled|not yet run/);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'name');
    expect(cardNames().slice(0, 3)).toEqual([
      'Autofix · breaker open',
      'Datadog Miner · healthy',
      'Dep Bumps · disabled',
    ]);
  });

  it('searches by name or source and filters by status', async () => {
    const { user } = renderWithProviders(<Processes />);
    await screen.findByRole('list', { name: 'Processes' });
    await user.type(screen.getByRole('searchbox', { name: 'Search processes' }), 'datadog');
    expect(cardNames()).toEqual(['Triage · healthy', 'Datadog Miner · healthy']);

    await user.clear(screen.getByRole('searchbox', { name: 'Search processes' }));
    await user.click(screen.getByRole('radio', { name: /Attention/ }));
    expect(cardNames()).toHaveLength(4);

    await user.type(
      screen.getByRole('searchbox', { name: 'Search processes' }),
      'nothing-like-this',
    );
    expect(screen.getByText('No processes match')).toBeInTheDocument();
  });

  it('shows only the load failure, with Retry, when the list cannot load', async () => {
    renderWithProviders(<Processes />, {
      overrides: {
        'GET /processes': () => mockStatus(500, { error: 'internal', message: 'database down' }),
      },
    });
    expect(await screen.findByText('Processes could not load')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No processes match')).toBeNull();
    expect(screen.queryByText('No processes yet')).toBeNull();
  });

  it('keeps the search, filter and sort in the URL', async () => {
    const { user, router } = renderWithProviders(<Processes />, {
      path: '/processes?q=datadog&sort=name',
    });
    await screen.findByRole('list', { name: 'Processes' });
    expect(screen.getByRole('searchbox', { name: 'Search processes' })).toHaveValue('datadog');
    expect(cardNames()).toEqual(['Datadog Miner · healthy', 'Triage · healthy']);
    await user.click(screen.getByRole('radio', { name: /Attention/ }));
    expect(router.state.location.search).toContain('filter=attention');
  });

  it('teaches the next step when there are no processes', async () => {
    renderWithProviders(<Processes />, { overrides: { 'GET /processes': () => [] } });
    expect(await screen.findByText('No processes yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New process' }).length).toBeGreaterThan(0);
  });

  it('opens the editor from New process', async () => {
    const { user, router } = renderWithProviders(<Processes />);
    await screen.findByRole('list', { name: 'Processes' });
    await user.click(screen.getByRole('button', { name: 'New process' }));
    expect(router.state.location.pathname).toBe('/processes/new');
  });

  it('keeps New process visible but disabled for viewers', async () => {
    renderWithProviders(<Processes />, { role: 'viewer' });
    await screen.findByRole('list', { name: 'Processes' });
    expect(screen.getByRole('button', { name: 'New process' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
