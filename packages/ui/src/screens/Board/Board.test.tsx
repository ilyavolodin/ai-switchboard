import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { emptyBoard } from '../../api/fixtures.js';
import { TEST_NOW } from '../../test/constants.js';
import { renderWithProviders } from '../../test/render.js';
import { Board } from './Board.js';

describe('Board', () => {
  it('draws every source, process and destination as a node that links to it', async () => {
    renderWithProviders(<Board />);
    const source = await screen.findByRole('link', {
      name: /^Source GitHub — acme org, auth failure, 141 events/,
    });
    expect(source).toHaveAttribute('href', '/sources/src-github');
    expect(screen.getByRole('link', { name: /^Process Autofix, breaker open/ })).toHaveAttribute(
      'href',
      '/processes/p-autofix',
    );
    expect(
      screen.getByRole('link', { name: /^Destination Claude Routines — automation seat, healthy/ }),
    ).toHaveAttribute('href', '/destinations/ex-routines');
    expect(screen.getAllByRole('link', { name: /^Process / })).toHaveLength(11);
    expect(screen.getAllByRole('link', { name: /^Source / })).toHaveLength(5);
  });

  it('shows the three key facts in the hover card', async () => {
    renderWithProviders(<Board />);
    const node = await screen.findByRole('link', { name: /^Source Linear — lola/ });
    expect(node).toHaveAccessibleDescription(/healthy.*312 events in 24 h.*last event 4 min ago/);
  });

  it('draws the edges with their volume', async () => {
    const { container } = renderWithProviders(<Board />);
    await screen.findByRole('link', { name: /^Process Autofix/ });
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.react-flow__edge').length).toBe(21);
    });
    expect(container.querySelectorAll('[data-part="flow-dot"]').length).toBeGreaterThan(0);
  });

  it('lists what needs attention with one-click actions', async () => {
    renderWithProviders(<Board />);
    const panel = await screen.findByRole('region', { name: 'Needs attention' });
    const rows = within(panel).getAllByRole('listitem');
    expect(rows).toHaveLength(6);
    expect(
      within(panel).getByRole('button', { name: 'Reset: Autofix breaker open' }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole('button', {
        name: 'Read meters: Claude Routines · weekly window stale',
      }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: 'Approve: Merge · batch awaiting approval' }),
    ).toBeInTheDocument();
  });

  it('resets a breaker with a reason', async () => {
    const { user, api } = renderWithProviders(<Board />);
    const panel = await screen.findByRole('region', { name: 'Needs attention' });
    await user.click(within(panel).getByRole('button', { name: 'Reset: Autofix breaker open' }));
    await user.type(
      await screen.findByRole('textbox', { name: /Reason/ }),
      'fixed the flaky suite',
    );
    await user.click(screen.getByRole('button', { name: 'Reset breaker' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /processes/p-autofix/breaker/reset')[0]?.body).toEqual({
        reason: 'fixed the flaky suite',
      });
    });
  });

  it('reloads the right kind of instance', async () => {
    const { user, api } = renderWithProviders(<Board />);
    const panel = await screen.findByRole('region', { name: 'Needs attention' });
    await user.click(
      within(panel).getByRole('button', { name: 'Reload: GitHub — acme org · auth failure' }),
    );
    await user.type(await screen.findByRole('textbox', { name: /Reason/ }), 'rotated the app key');
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /sources/src-github/reload')).toHaveLength(1);
    });
  });

  it('keeps actions visible but disabled for viewers', async () => {
    renderWithProviders(<Board />, { role: 'viewer' });
    const panel = await screen.findByRole('region', { name: 'Needs attention' });
    const reset = within(panel).getByRole('button', { name: 'Reset: Autofix breaker open' });
    expect(reset).toHaveAttribute('aria-disabled', 'true');
    expect(reset).toHaveAccessibleDescription(/needs the Operator role/);
    // Navigation-only actions stay available.
    expect(within(panel).getByRole('button', { name: /^Plugins:/ })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('focuses one process from the filter row', async () => {
    const { user, router } = renderWithProviders(<Board />);
    await screen.findByRole('link', { name: /^Process Autofix/ });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Focus one process' }),
      'p-autofix',
    );
    expect(router.state.location.search).toBe('?focus=p-autofix');
    expect(screen.getAllByRole('link', { name: /^Process / })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: /^Source / })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Autofix only' }));
    expect(screen.getAllByRole('link', { name: /^Process / })).toHaveLength(11);
  });

  it('hides disabled nodes', async () => {
    const { user } = renderWithProviders(<Board />);
    await screen.findByRole('link', { name: /^Process Dep Bumps/ });
    await user.click(screen.getByRole('radio', { name: /Hide disabled/ }));
    expect(screen.queryByRole('link', { name: /^Process Dep Bumps/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Source Slack/ })).toBeNull();
  });

  it('teaches the three first steps on an empty installation', async () => {
    renderWithProviders(<Board />, { overrides: { 'GET /board': () => emptyBoard(TEST_NOW) } });
    expect(await screen.findByText('Nothing is wired yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a source' })).toHaveAttribute('href', '/sources');
    expect(screen.getByRole('link', { name: 'Add a destination' })).toHaveAttribute(
      'href',
      '/destinations',
    );
    expect(screen.getByRole('link', { name: 'New process' })).toHaveAttribute(
      'href',
      '/processes/new',
    );
    expect(screen.getByText('Nothing needs you')).toBeInTheDocument();
  });

  it('shows a retryable error when the board cannot load', async () => {
    renderWithProviders(<Board />, {
      overrides: {
        'GET /board': () => ({
          __mockStatus: 503,
          body: { error: 'unavailable', message: 'database unreachable' },
        }),
      },
    });
    expect(await screen.findByText(/database unreachable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
