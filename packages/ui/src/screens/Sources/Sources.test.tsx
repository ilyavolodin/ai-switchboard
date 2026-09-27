import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../test/render.js';
import { Sources } from './Sources.js';

async function card(name: string) {
  return screen.findByRole('article', { name });
}

describe('Sources', () => {
  it('draws one card per source with status, last event and events by type', async () => {
    renderWithProviders(<Sources />);
    const linear = await card('Linear — lola');
    expect(within(linear).getByRole('link', { name: 'Linear — lola' })).toHaveAttribute(
      'href',
      '/sources/src-linear',
    );
    expect(within(linear).getByText('healthy')).toBeInTheDocument();
    expect(within(linear).getByText('4 min ago')).toBeInTheDocument();
    expect(
      within(linear).getByRole('img', {
        name: 'Events by type in 24 h: issue.label_added 168, issue.state_changed 96, comment.created 48',
      }),
    ).toBeInTheDocument();
    expect(within(linear).getByText('312')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(5);
    expect(screen.getByText('5 sources · 4 enabled')).toBeInTheDocument();
  });

  it('flags unavailable plugins in amber and unauthenticated sources in red', async () => {
    renderWithProviders(<Sources />);
    const braintrust = await card('Braintrust — webhook');
    expect(within(braintrust).getByText('plugin unavailable')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByText(/A plugin is unavailable/)).toBeInTheDocument();
    const slack = await card('Slack — Events API');
    expect(within(slack).getByText('unauthenticated')).toHaveAttribute('data-tone', 'error');
    expect(
      within(slack).getByRole('switch', { name: 'Slack — Events API enabled' }),
    ).toHaveAttribute('aria-checked', 'false');
    const github = await card('GitHub — acme org');
    expect(github).toHaveAttribute('data-tone', 'error');
  });

  it('disables a source with a reason', async () => {
    const { user, api } = renderWithProviders(<Sources />);
    const linear = await card('Linear — lola');
    await user.click(within(linear).getByRole('switch', { name: 'Linear — lola enabled' }));
    expect(await screen.findByText(/stop receiving its events/)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Reason/ }), 'noisy during migration');
    await user.click(screen.getByRole('button', { name: 'Disable source' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /sources/src-linear/enable')[0]?.body).toEqual({
        enabled: false,
        reason: 'noisy during migration',
      });
    });
  });

  it('adds a source: type, settings with secret references (never values), caps, reason', async () => {
    const { user, api, router } = renderWithProviders(<Sources />);
    await user.click(await screen.findByRole('button', { name: 'Add source' }));
    const picker = await screen.findByRole('dialog', { name: 'Add a source' });
    await user.click(within(picker).getByRole('button', { name: /Linear/ }));

    const form = await screen.findByRole('dialog', { name: 'New Linear source' });
    const name = within(form).getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, 'Linear — platform');
    await user.type(within(form).getByLabelText(/Team key/), 'PLT');
    await user.type(within(form).getByRole('textbox', { name: /^API key/ }), 'LINEAR_API_KEY');
    await user.type(
      within(form).getByRole('textbox', { name: /^Webhook signing secret/ }),
      'LINEAR_WEBHOOK_SECRET',
    );
    await user.type(within(form).getByLabelText('Events per hour'), '300');
    await user.click(within(form).getByRole('checkbox', { name: 'Receive issue.state_changed' }));
    await user.click(within(form).getByRole('button', { name: 'Create source' }));

    await user.type(await screen.findByRole('textbox', { name: /Reason/ }), 'platform team');
    await user.click(screen.getByRole('button', { name: 'Create source' }));

    await vi.waitFor(() => {
      expect(api.callsTo('POST /sources')).toHaveLength(1);
    });
    const body = api.callsTo('POST /sources')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      typeId: 'linear',
      name: 'Linear — platform',
      reason: 'platform team',
      enabled: true,
      settings: {
        team: 'PLT',
        apiKey: 'secret://env/LINEAR_API_KEY',
        webhookSecret: 'secret://env/LINEAR_WEBHOOK_SECRET',
      },
      caps: {
        eventCapPerHour: 300,
        eventTypesEnabled: ['issue.label_added'],
      },
    });
    // Secret fields only ever carry references.
    const settings = body.settings as Record<string, unknown>;
    expect(settings.apiKey).toMatch(/^secret:\/\//);
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/sources/src-linear');
    });
  });

  it('keeps the form when the reason prompt is cancelled and blocks invalid settings', async () => {
    const { user, api } = renderWithProviders(<Sources />);
    await user.click(await screen.findByRole('button', { name: 'Add source' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Add a source' })).getByRole('button', {
        name: /Linear/,
      }),
    );
    const form = await screen.findByRole('dialog', { name: 'New Linear source' });
    await user.click(within(form).getByRole('button', { name: 'Create source' }));
    expect(within(form).getByText('Some fields need attention')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Reason/ })).toBeNull();

    await user.type(within(form).getByLabelText(/Team key/), 'LOL');
    await user.type(within(form).getByRole('textbox', { name: /^API key/ }), 'K');
    await user.type(within(form).getByRole('textbox', { name: /^Webhook signing secret/ }), 'S');
    await user.click(within(form).getByRole('button', { name: 'Create source' }));
    await screen.findByRole('textbox', { name: /Reason/ });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const again = await screen.findByRole('dialog', { name: 'New Linear source' });
    expect(within(again).getByLabelText(/Team key/)).toHaveValue('LOL');
    expect(api.callsTo('POST /sources')).toHaveLength(0);
  });

  it('shows an empty state that teaches the next step', async () => {
    renderWithProviders(<Sources />, { overrides: { 'GET /sources': () => [] } });
    expect(await screen.findByText('No sources yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add source' }).length).toBeGreaterThan(0);
  });

  it('keeps controls visible but disabled for viewers', async () => {
    renderWithProviders(<Sources />, { role: 'viewer' });
    const linear = await card('Linear — lola');
    expect(screen.getByRole('button', { name: 'Add source' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(linear).getByRole('switch', { name: 'Linear — lola enabled' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
