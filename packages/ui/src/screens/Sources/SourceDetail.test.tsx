import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SourceDetail as SourceDetailDTO, StatsWindow } from '@ai-switchboard/core/contract';

import { buildFixtures } from '../../api/fixtures.js';
import { mockStatus } from '../../api/mockApi.js';
import { at } from '../../lib/at.js';
import type { RenderOptions } from '../../test/render.js';
import { renderWithProviders, TEST_NOW } from '../../test/render.js';
import { SourceDetail } from './SourceDetail.js';

function renderSource(path: string, options: RenderOptions = {}) {
  const routePath = path.split('/').length > 3 ? '/sources/:id/:tab' : '/sources/:id';
  return renderWithProviders(<SourceDetail />, { path, routePath, ...options });
}

async function reasonAndConfirm(
  user: ReturnType<typeof renderSource>['user'],
  reason: string,
  confirm: string,
) {
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), reason);
  await user.click(within(dialog).getByRole('button', { name: confirm }));
}

describe('SourceDetail', () => {
  it('shows the webhook URL, secret references with verified times, and the tabs', async () => {
    renderSource('/sources/src-linear');
    expect(await screen.findByRole('heading', { name: 'Linear — lola', level: 1 })).toBeVisible();
    expect(screen.getByText('https://switchboard.lola.com/hooks/src-linear')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy webhook URL' })).toBeInTheDocument();
    const secrets = screen.getByRole('list', { name: 'Secret references' });
    expect(within(secrets).getByText('LINEAR_WEBHOOK_SECRET')).toBeInTheDocument();
    expect(within(secrets).getAllByText(/verified/)).toHaveLength(2);
    expect(within(secrets).getAllByText('13 h ago')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Register webhook' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Source sections' });
    expect(within(tabs).getByRole('link', { name: /Events/ })).toHaveAttribute(
      'href',
      '/sources/src-linear/events',
    );
  });

  it('shows the poll interval for a pull source and no Register webhook', async () => {
    renderSource('/sources/src-datadog');
    expect(await screen.findByText('polls every 5 min')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register webhook' })).toBeNull();
  });

  it('shows the instance error and the unavailable-plugin banner', async () => {
    renderSource('/sources/src-github');
    expect(await screen.findByText(/installation token refresh failed/)).toBeInTheDocument();
    renderSource('/sources/src-braintrust');
    expect(await screen.findByText('Plugin unavailable')).toBeInTheDocument();
  });

  it('sends a test event, registers the webhook and reloads, each with a reason', async () => {
    const { user, api } = renderSource('/sources/src-linear');
    await user.click(await screen.findByRole('button', { name: 'Send test event' }));
    await reasonAndConfirm(user, 'checking the trigger', 'Send test event');
    await vi.waitFor(() => {
      expect(api.callsTo('POST /sources/src-linear/test-event')[0]?.body).toEqual({
        reason: 'checking the trigger',
      });
    });
    expect(await screen.findByText(/Test event sent · ev-test-1/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Register webhook' }));
    await reasonAndConfirm(user, 'new org', 'Register webhook');
    await vi.waitFor(() => {
      expect(api.callsTo('POST /sources/src-linear/provision')[0]?.body).toEqual({
        reason: 'new org',
      });
    });

    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await reasonAndConfirm(user, 'rotated key', 'Reload');
    await vi.waitFor(() => {
      expect(api.callsTo('POST /sources/src-linear/reload')[0]?.body).toEqual({
        reason: 'rotated key',
      });
    });
  });

  it('says why nothing ran after a test event, with a link to its trace', async () => {
    const f = buildFixtures(TEST_NOW);
    const { user } = renderSource('/sources/src-linear', {
      overrides: {
        'GET /events/:id': ({ params }) => ({
          ...f.eventDetail,
          eventId: params.id ?? '',
          stage: 'unmatched',
          indicator: { reached: 1, tone: 'off', label: 'no process wants it' },
          processes: [],
          explanations: [
            {
              processId: 'p-autofix',
              processName: 'Autofix',
              taken: false,
              reason: 'process is disabled',
              basis: 'recorded',
              tone: 'warn',
            },
          ],
        }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Send test event' }));
    await reasonAndConfirm(user, 'why is nothing running', 'Send test event');
    expect(await screen.findByText('Test event sent: nothing ran')).toBeInTheDocument();
    const why = screen.getByRole('list', { name: 'Why nothing ran' });
    expect(within(why).getByRole('link', { name: 'Autofix' })).toHaveAttribute(
      'href',
      '/processes/p-autofix',
    );
    expect(why).toHaveTextContent('Autofix: process is disabled');
    expect(screen.getByRole('link', { name: 'Open its trace' })).toHaveAttribute(
      'href',
      '/activity/trace/ev-test-1',
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss the test event result' }));
    expect(screen.queryByText('Test event sent: nothing ran')).toBeNull();
  });

  it('draws the overview charts and asks for the chosen window', async () => {
    const windows: (string | null)[] = [];
    const { user, api } = renderSource('/sources/src-linear', {
      overrides: {
        'GET /sources/:id/stats': (r) => {
          windows.push(r.query.get('window'));
          return { ...api.fixtures.sourceStats, window: r.query.get('window') as StatsWindow };
        },
      },
    });
    expect(
      await screen.findByRole('img', { name: 'Events per hour by type over 24 h' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Events per hour by pipeline stage over 24 h' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Verify failures by hour' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: '7 d' }));
    expect(
      await screen.findByRole('img', { name: 'Events per day by type over 7 d' }),
    ).toBeInTheDocument();
    expect(windows).toContain('24h');
    expect(windows).toContain('7d');
  });

  it('lists events; a row opens its attributes and Replay sends a reason', async () => {
    const { user, api } = renderSource('/sources/src-linear/events');
    const list = await screen.findByRole('list', { name: 'Events from Linear — lola' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(1);
    const toggle = within(list).getByRole('button', { name: 'Show issue.label_added LOL-1720' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const kv = await screen.findByLabelText('Event attributes');
    expect(within(kv).getByText('label')).toBeInTheDocument();
    expect(within(kv).getByText('autofix')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Replay' }));
    expect(await screen.findByText(/reaches Triage/)).toBeInTheDocument();
    await reasonAndConfirm(user, 'the run was lost', 'Replay');
    await vi.waitFor(() => {
      expect(api.callsTo('POST /events/ev-1720/replay')[0]?.body).toEqual({
        reason: 'the run was lost',
      });
    });
  });

  it('saves settings, caps and the mute list with a reason', async () => {
    const { user, api } = renderSource('/sources/src-linear/settings');
    const team = await screen.findByRole('textbox', { name: 'Teams 1' });
    expect(screen.getByRole('region', { name: 'Save settings' })).toHaveTextContent(
      'No unsaved changes',
    );
    await user.clear(team);
    await user.type(team, 'PLAT');
    const perHour = screen.getByLabelText('Events per hour');
    await user.clear(perHour);
    await user.type(perHour, '120');
    await user.click(screen.getByRole('checkbox', { name: 'Receive issue.state_changed' }));
    expect(screen.getByRole('region', { name: 'Save settings' })).toHaveTextContent(
      '2 unsaved changes',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await reasonAndConfirm(user, 'moved team', 'Save changes');
    await vi.waitFor(() => {
      expect(api.callsTo('PUT /sources/src-linear')).toHaveLength(1);
    });
    expect(api.callsTo('PUT /sources/src-linear')[0]?.body).toMatchObject({
      reason: 'moved team',
      name: 'Linear — lola',
      settings: { teamKeys: ['PLAT'], apiKey: 'secret://env/LINEAR_API_KEY' },
      caps: {
        eventCapPerHour: 120,
        eventCapPerDay: 5000,
        eventTypesEnabled: ['issue.label_added'],
      },
    });
  });

  it('is clean after a save the server normalises (defaults, key order, derived caps)', async () => {
    const fixtures = buildFixtures(TEST_NOW);
    let current: SourceDetailDTO = fixtures.sourceDetail(
      at(
        fixtures.sources.filter((s) => s.id === 'src-linear'),
        0,
      ),
    );
    const { user, api, router } = renderSource(`/sources/${current.id}/settings`, {
      fixtures,
      overrides: {
        'GET /sources/:id': () => current,
        // Like the real PUT: Ajv fills schema defaults, jsonb reorders keys and the core derives
        // `caps.unauthenticated` from the built instance.
        'PUT /sources/:id': (r) => {
          const body = r.body!;
          const settings = { ...(body.settings ?? {}) };
          const reordered = Object.fromEntries(
            Object.entries({ filledDefault: 'on', ...settings }).reverse(),
          );
          current = {
            ...current,
            name: body.name ?? current.name,
            settings: reordered,
            caps: { ...body.caps, unauthenticated: true },
          };
          return current;
        },
      },
    });
    const team = await screen.findByRole('textbox', { name: 'Teams 1' });
    await user.clear(team);
    await user.type(team, 'PLAT');
    const region = screen.getByRole('region', { name: 'Save settings' });
    expect(region).toHaveTextContent('1 unsaved change');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await reasonAndConfirm(user, 'moved team', 'Save changes');
    await vi.waitFor(() => {
      expect(api.callsTo(`PUT /sources/${current.id}`)).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(region).toHaveTextContent('No unsaved changes');
    });
    expect(screen.getByRole('textbox', { name: 'Teams 1' })).toHaveValue('PLAT');
    await act(() => router.navigate(`/sources/${current.id}`));
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).toBeNull();
    expect(router.state.location.pathname).toBe(`/sources/${current.id}`);
  });

  it('keeps actions visible but disabled for viewers', async () => {
    renderSource('/sources/src-linear', { role: 'viewer' });
    for (const name of ['Register webhook', 'Send test event', 'Reload']) {
      expect(await screen.findByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    }
    expect(screen.getByRole('switch', { name: 'Enabled' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows the settings form disabled for viewers', async () => {
    renderSource('/sources/src-linear/settings', { role: 'viewer' });
    expect(await screen.findByRole('textbox', { name: 'Teams 1' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: /^Name/ })).toBeDisabled();
    expect(screen.getByLabelText('Events per hour')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete source' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('asks before leaving the settings tab with unsaved changes', async () => {
    const { user, router } = renderSource('/sources/src-linear/settings');
    await user.type(await screen.findByRole('textbox', { name: 'Teams 1' }), 'X');
    await act(() => router.navigate('/sources/src-linear'));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(router.state.location.pathname).toBe('/sources/src-linear/settings');
    expect(screen.getByRole('textbox', { name: 'Teams 1' })).toHaveValue('LOLX');
  });

  it('names the processes that still use it instead of asking to delete', async () => {
    const f = buildFixtures(TEST_NOW);
    const linear = at(
      f.sources.filter((x) => x.id === 'src-linear'),
      0,
    );
    const { api, user } = renderSource('/sources/src-linear/settings', {
      overrides: {
        'GET /sources/:id': () => ({
          ...f.sourceDetail(linear),
          processes: [{ id: 'p-autofix', name: 'Autofix', eventTypes: ['issue.label_added'] }],
        }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Delete source' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Linear — lola is still in use')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Autofix' })).toHaveAttribute(
      'href',
      '/processes/p-autofix/edit',
    );
    expect(screen.getByText(/remove its triggers from each/)).toBeInTheDocument();
    expect(api.callsTo('DELETE /sources/src-linear')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Linear — lola is still in use')).toBeNull();
  });

  it('turns a 409 "still used by" into links to those processes', async () => {
    const { api, user } = renderSource('/sources/src-linear/settings', {
      overrides: {
        'DELETE /sources/:id': () =>
          mockStatus(409, {
            error: 'conflict',
            message: 'Still used by Autofix, Triage. Remove it from those processes first.',
            usedBy: [
              { id: 'p-autofix', name: 'Autofix' },
              { id: 'p-triage', name: 'Triage' },
            ],
          }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Delete source' }));
    await reasonAndConfirm(user, 'unused now', 'Delete source');
    expect(await screen.findByText('Linear — lola is still in use')).toBeInTheDocument();
    expect(api.callsTo('DELETE /sources/src-linear')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Autofix' })).toHaveAttribute(
      'href',
      '/processes/p-autofix/edit',
    );
    expect(screen.getByRole('link', { name: 'Triage' })).toHaveAttribute(
      'href',
      '/processes/p-triage/edit',
    );
    expect(screen.getByText(/or delete those processes/)).toBeInTheDocument();
    expect(screen.queryByText('That did not work')).toBeNull();
  });

  it('says so when the source does not exist', async () => {
    renderSource('/sources/nope');
    expect(await screen.findByText('This source does not exist')).toBeInTheDocument();
  });
});
