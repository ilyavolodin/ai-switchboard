import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildFixtures } from '../../api/fixtures.js';
import type { MockHandlers } from '../../api/mockApi.js';
import { TEST_NOW } from '../../test/constants.js';
import { renderApp, renderWithProviders } from '../../test/render.js';
import { Activity } from './Activity.js';

/** Records the query of every GET /events. */
function capture() {
  const seen: URLSearchParams[] = [];
  const { activity } = buildFixtures(TEST_NOW);
  const overrides: MockHandlers = {
    'GET /events': (req) => {
      seen.push(new URLSearchParams(req.query));
      return { items: activity, nextCursor: null };
    },
  };
  return { seen, overrides };
}

describe('Activity', () => {
  it('shows each event with where it stopped and the processes it reached', async () => {
    renderWithProviders(<Activity />, { path: '/activity' });
    const list = await screen.findByRole('list', { name: 'Events' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(8);
    const held = within(list).getByRole('listitem', {
      name: 'check_suite.completed 480: held · awaiting approval',
    });
    expect(within(held).getByRole('img', { name: /reached batched \(3 of 5\)/ })).toBeVisible();
    expect(within(held).getByRole('link', { name: 'Merge' })).toHaveAttribute(
      'href',
      '/processes/p-merge',
    );
    expect(within(held).getByRole('link', { name: /#480/ })).toHaveAttribute(
      'href',
      '/activity/trace/480',
    );
    expect(
      within(list).getByRole('listitem', { name: /LOL-1709: no process matched/ }),
    ).toHaveTextContent('why: Autofix: event type comment.created is not in trigger');
  });

  it('puts filters in the URL and sends them to GET /events', async () => {
    const { seen, overrides } = capture();
    const { user, router } = renderWithProviders(<Activity />, { path: '/activity', overrides });
    await screen.findByRole('list', { name: 'Events' });

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Source' }), 'src-linear');
    await vi.waitFor(() => {
      expect(seen.at(-1)?.get('source')).toBe('src-linear');
    });
    expect(router.state.location.search).toContain('source=src-linear');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), 'unmatched');
    await vi.waitFor(() => {
      expect(seen.at(-1)?.get('stage')).toBe('unmatched');
    });
    expect(seen.at(-1)?.get('source')).toBe('src-linear');
    // The default range sends a lower bound 24 h back.
    expect(seen.at(-1)?.get('from')).toBe('2026-09-26T12:00:00.000Z');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Time range' }), 'all');
    await vi.waitFor(() => {
      expect(seen.at(-1)?.has('from')).toBe(false);
    });

    await user.type(screen.getByRole('textbox', { name: 'Artifact id' }), 'LOL-1712{Enter}');
    await vi.waitFor(() => {
      expect(seen.at(-1)?.get('artifact')).toBe('LOL-1712');
    });
    expect(router.state.location.search).toContain('artifact=LOL-1712');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(router.state.location.search).toBe('?range=all');
  });

  it('reads the filters from the URL', async () => {
    const { seen, overrides } = capture();
    renderWithProviders(<Activity />, {
      path: '/activity?process=p-autofix&executor=ex-routines&range=7d',
      overrides,
    });
    await screen.findByRole('list', { name: 'Events' });
    expect(seen[0]?.get('process')).toBe('p-autofix');
    expect(seen[0]?.get('executor')).toBe('ex-routines');
    expect(seen[0]?.get('from')).toBe('2026-09-20T12:00:00.000Z');
    expect(await screen.findByRole('combobox', { name: 'Process' })).toHaveValue('p-autofix');
  });

  it('traces an artifact from the search box', async () => {
    const { user, router } = renderWithProviders(<Activity />, { path: '/activity' });
    await user.type(
      screen.getByRole('searchbox', { name: 'Trace an artifact' }),
      'LOL-1712{Enter}',
    );
    expect(router.state.location.pathname).toBe('/activity/trace/LOL-1712');
  });

  it('teaches what to do when nothing matches', async () => {
    renderWithProviders(<Activity />, {
      path: '/activity?source=src-linear',
      overrides: { 'GET /events': () => ({ items: [], nextCursor: null }) },
    });
    expect(await screen.findByText('No events match these filters')).toBeVisible();
  });

  it('is routed at /activity and /activity/trace/:query', async () => {
    const { user } = renderApp('/activity');
    const list = await screen.findByRole('list', { name: 'Events' });
    const row = within(list).getByRole('listitem', {
      name: 'issue.label_added LOL-1712: run error',
    });
    await user.click(within(row).getByRole('link', { name: /LOL-1712/ }));
    expect(await screen.findByRole('list', { name: 'Trace timeline' })).toBeVisible();
  });

  it('keeps a filter on a deleted source visible instead of showing "All sources"', async () => {
    renderWithProviders(<Activity />, { path: '/activity?source=src-gone' });
    const select = await screen.findByRole('combobox', { name: 'Source' });
    await vi.waitFor(() => {
      expect(within(select).getByRole('option', { name: 'Linear — lola' })).toBeInTheDocument();
    });
    expect(select).toHaveValue('src-gone');
    expect(
      within(select).getByRole('option', { name: 'src-gone (not found)' }),
    ).toBeInTheDocument();
  });
});
