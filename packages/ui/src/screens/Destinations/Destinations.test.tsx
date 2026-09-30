import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildFixtures } from '../../api/fixtures.js';
import { at } from '../../lib/at.js';
import { TEST_NOW } from '../../test/constants.js';
import { renderWithProviders } from '../../test/render.js';
import { Destinations } from './Destinations.js';

describe('Destinations', () => {
  it('draws one card per destination with health and its meters as arcs', async () => {
    renderWithProviders(<Destinations />);
    const routines = await screen.findByRole('article', {
      name: 'Claude Routines — automation seat',
    });
    expect(
      within(routines).getByRole('link', { name: 'Claude Routines — automation seat' }),
    ).toHaveAttribute('href', '/destinations/dst-routines');
    expect(within(routines).getByText('healthy')).toBeInTheDocument();
    const meters = within(routines).getByRole('list', {
      name: 'Claude Routines — automation seat meters',
    });
    expect(within(meters).getAllByRole('listitem')).toHaveLength(3);
    expect(within(meters).getByText('5-hour window')).toBeInTheDocument();
    expect(within(meters).getByText(/resets in 2 h 10 m/)).toBeInTheDocument();
    expect(within(meters).getByText(/last read 42 min ago/)).toBeInTheDocument();

    const actions = screen.getByRole('article', { name: 'GitHub Actions — lola org' });
    expect(actions).toHaveAttribute('data-tone', 'error');
    expect(within(actions).getByText('unhealthy')).toBeInTheDocument();
    expect(
      within(screen.getByRole('article', { name: 'HTTP — internal jobs' })).getByText(/No meters/),
    ).toBeInTheDocument();
    expect(screen.getByText('3 instances · 3 types')).toBeInTheDocument();
  });

  it('shows the soft-hold chip and when it lifts', async () => {
    renderWithProviders(<Destinations />, {
      overrides: {
        'GET /destinations': () => [
          {
            ...at(buildFixtures(TEST_NOW).destinations, 0),
            softHoldUntil: new Date(TEST_NOW + 20 * 60_000).toISOString(),
            softHoldReason: 'backend asked to back off (429)',
          },
        ],
      },
    });
    const card = await screen.findByRole('article', { name: 'Claude Routines — automation seat' });
    expect(within(card).getByText('soft hold')).toHaveAttribute('data-tone', 'warn');
    expect(within(card).getByText(/lifts in/)).toHaveTextContent('lifts in 20 m');
  });

  it('adds a destination with settings, secret references and caps', async () => {
    const { user, api, router } = renderWithProviders(<Destinations />);
    await user.click(await screen.findByRole('button', { name: 'Add destination' }));
    const picker = await screen.findByRole('dialog', { name: 'Add a destination' });
    await user.click(within(picker).getByRole('button', { name: /Claude Routines/ }));
    const form = await screen.findByRole('dialog', { name: 'New Claude Routines destination' });
    await user.type(within(form).getByRole('textbox', { name: /^Trigger token/ }), 'ROUTINE_TOKEN');
    await user.type(
      within(form).getByRole('textbox', { name: /^Callback secret/ }),
      'ROUTINE_CALLBACK_SECRET',
    );
    await user.type(within(form).getByLabelText('Runs per day'), '20');
    await user.type(within(form).getByLabelText('Meter staleness'), '15');
    await user.click(within(form).getByRole('button', { name: 'Create destination' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'new seat');
    await user.click(within(dialog).getByRole('button', { name: 'Create destination' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /destinations')).toHaveLength(1);
    });
    expect(api.callsTo('POST /destinations')[0]?.body).toMatchObject({
      typeId: 'claude-routines',
      name: 'Claude Routines',
      reason: 'new seat',
      settings: {
        token: 'secret://env/ROUTINE_TOKEN',
        callbackSecret: 'secret://env/ROUTINE_CALLBACK_SECRET',
        apiBaseUrl: 'https://api.anthropic.com',
      },
      caps: { runsPerDay: 20, meterStalenessMinutes: 15 },
    });
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/destinations/dst-new-1');
    });
  });

  it('keeps Add destination and the toggles visible but disabled for viewers', async () => {
    renderWithProviders(<Destinations />, { role: 'viewer' });
    expect(await screen.findByRole('button', { name: 'Add destination' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      await screen.findByRole('switch', { name: 'HTTP — internal jobs enabled' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });
});
