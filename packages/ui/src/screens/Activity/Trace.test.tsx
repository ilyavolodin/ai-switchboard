import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { mockStatus } from '../../api/mockApi.js';
import { renderWithProviders } from '../../test/render.js';
import { Trace } from './Trace.js';

const at = (query: string) => ({
  path: `/activity/trace/${encodeURIComponent(query)}`,
  routePath: '/activity/trace/:query',
});

describe('Trace', () => {
  it('asks for the artifact and shows every decision on one timeline', async () => {
    const { api } = renderWithProviders(<Trace />, at('LOL-1712'));
    const timeline = await screen.findByRole('list', { name: 'Trace timeline' });
    expect(api.calls.find((c) => c.path === '/trace')).toBeDefined();
    const items = within(timeline).getAllByRole('listitem');
    expect(items).toHaveLength(9);

    // Filter decision: the expression and its result are open by default.
    const filter = within(timeline).getByText('Filter matched').closest('li');
    expect(filter).toHaveTextContent("attributes.label = 'autofix'");
    expect(filter).toHaveTextContent('true');

    // Gate checks pass/fail, budget check with the binding limit and meter readings.
    const gate = within(timeline).getByText('Gate checks passed').closest('li');
    expect(gate).toHaveTextContent('closed · pass');
    const budget = within(timeline).getByText('Budget ok').closest('li');
    expect(budget).toHaveTextContent('process day cap');
    expect(budget).toHaveTextContent('62% (ceiling 85%)');

    // The invoke links out in a new tab; the terminal state is marked failed.
    const invoke = within(timeline).getByText('Invoked').closest('li');
    expect(within(invoke as HTMLElement).getByRole('link', { name: /open/ })).toHaveAttribute(
      'target',
      '_blank',
    );
    const terminal = within(timeline).getByText('Run error after 6 m 38 s').closest('li');
    expect(terminal).toHaveTextContent('failed');
  });

  it('says why nothing ran for an event no process took', async () => {
    renderWithProviders(<Trace />, {
      ...at('ev-1'),
      overrides: {
        'GET /trace': () => ({
          query: 'ev-1',
          artifacts: [{ kind: 'linear.issue', id: 'LOL-1' }],
          entries: [
            {
              at: '2026-09-27T08:00:00.000Z',
              kind: 'event',
              tone: 'off',
              title: 'issue.label_added on linear.issue LOL-1: unmatched',
              eventId: 'ev-1',
            },
            {
              at: '2026-09-27T08:00:00.100Z',
              kind: 'filter',
              tone: 'warn',
              title: 'Autofix did not take it: process is disabled',
              data: { taken: false, reason: 'process is disabled', basis: 'recorded' },
              eventId: 'ev-1',
              processId: 'p-autofix',
              processName: 'Autofix',
            },
            {
              at: '2026-09-27T08:00:00.100Z',
              kind: 'filter',
              tone: 'off',
              title: 'Triage did not take it: trigger "labels" is disabled',
              data: { taken: false, reason: 'trigger "labels" is disabled', basis: 'now' },
              eventId: 'ev-1',
              processId: 'p-triage',
              processName: 'Triage',
            },
          ],
          text: '',
        }),
      },
    });
    const why = await screen.findByRole('region', { name: 'Why nothing ran' });
    expect(within(why).getByRole('link', { name: 'Autofix' })).toBeVisible();
    expect(why).toHaveTextContent('Autofix: process is disabled');
    expect(why).toHaveTextContent('Triage: trigger "labels" is disabled (now)');
    // A process that did not take the event did not touch it.
    const touched = screen.getByRole('region', { name: 'Processes that touched it' });
    expect(within(touched).getByText('No process matched it.')).toBeVisible();
    const stands = screen.getByRole('region', { name: 'Where it stands' });
    expect(stands).toHaveTextContent(/did not take it/);
  });

  it('shows the artifact chips, counts and where it stands', async () => {
    renderWithProviders(<Trace />, at('LOL-1712'));
    expect(await screen.findByRole('link', { name: /LOL-1712 \(opens Linear/ })).toHaveAttribute(
      'href',
      'https://linear.app/lola/issue/LOL-1712',
    );
    expect(screen.getByText(/2 events · 1 process · 1 run · 0 ok, 1 error/)).toBeVisible();
    const touched = screen.getByRole('region', { name: 'Processes that touched it' });
    expect(within(touched).getByRole('link', { name: 'Autofix' })).toBeVisible();
    expect(within(touched).getByText('run error')).toBeVisible();
  });

  it('copies the server text of the timeline', async () => {
    const { user, api } = renderWithProviders(<Trace />, at('LOL-1712'));
    await screen.findByRole('list', { name: 'Trace timeline' });
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    await user.click(screen.getByRole('button', { name: 'Copy as text' }));
    expect(write).toHaveBeenCalledWith(api.fixtures.trace.text);
    expect(await screen.findByText('Timeline copied')).toBeVisible();
  });

  it('teaches the query forms when nothing is found', async () => {
    renderWithProviders(<Trace />, {
      ...at('LOL-9999'),
      overrides: {
        'GET /trace': () => ({ query: 'LOL-9999', artifacts: [], entries: [], text: '' }),
      },
    });
    expect(await screen.findByText('Nothing found for “LOL-9999”')).toBeVisible();
    expect(screen.getByRole('link', { name: 'LOL-1712' })).toHaveAttribute(
      'href',
      '/activity/trace/LOL-1712',
    );
    expect(screen.getByRole('link', { name: '#482' })).toHaveAttribute(
      'href',
      '/activity/trace/%23482',
    );
    expect(screen.getByRole('link', { name: 'linear.issue:LOL-1712' })).toBeVisible();
  });

  it('treats a 404 as not found', async () => {
    renderWithProviders(<Trace />, {
      ...at('#9'),
      overrides: {
        'GET /trace': () => mockStatus(404, { error: 'not_found', message: 'no events' }),
      },
    });
    expect(await screen.findByText('Nothing found for “#9”')).toBeVisible();
  });
});
