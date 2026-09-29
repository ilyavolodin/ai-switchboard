import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../test/render.js';
import { Sources } from './Sources.js';

async function card(name: string) {
  return screen.findByRole('article', { name });
}

async function addTeam(
  user: ReturnType<typeof renderWithProviders>['user'],
  form: HTMLElement,
  team: string,
) {
  const teams = within(form).getByRole('group', { name: 'Teams' });
  await user.click(within(teams).getByRole('button', { name: 'Add' }));
  await user.type(within(teams).getByRole('textbox', { name: 'Teams 1' }), team);
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
    await addTeam(user, form, 'PLT');
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
        teamKeys: ['PLT'],
        apiKey: 'secret://env/LINEAR_API_KEY',
        webhookSecret: 'secret://env/LINEAR_WEBHOOK_SECRET',
      },
      caps: {
        eventCapPerHour: 300,
        eventTypesEnabled: ['issue.label_added'],
      },
    });
    const settings = body.settings as Record<string, unknown>;
    expect(settings.apiKey).toMatch(/^secret:\/\//);
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/sources/src-new-1');
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

    await addTeam(user, form, 'LOL');
    await user.type(within(form).getByRole('textbox', { name: /^API key/ }), 'K');
    await user.type(within(form).getByRole('textbox', { name: /^Webhook signing secret/ }), 'S');
    await user.click(within(form).getByRole('button', { name: 'Create source' }));
    await screen.findByRole('textbox', { name: /Reason/ });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const again = await screen.findByRole('dialog', { name: 'New Linear source' });
    expect(within(again).getByRole('textbox', { name: 'Teams 1' })).toHaveValue('LOL');
    expect(api.callsTo('POST /sources')).toHaveLength(0);
  });

  it('creates an unauthenticated webhook from Verification alone: none needs no secret', async () => {
    const { user, api } = renderWithProviders(<Sources />);
    await user.click(await screen.findByRole('button', { name: 'Add source' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Add a source' })).getByRole('button', {
        name: /^Webhook/,
      }),
    );
    const form = await screen.findByRole('dialog', { name: 'New Webhook source' });
    expect(within(form).queryByText(/Accept unauthenticated/)).toBeNull();
    expect(within(form).getByRole('textbox', { name: /^Secret/ })).toBeInTheDocument();
    expect(within(form).queryByText(/Anyone who knows the URL/)).toBeNull();

    await user.click(
      within(form).getByRole('radio', {
        name: 'None — accept unauthenticated deliveries (evaluation only)',
      }),
    );
    expect(within(form).queryByRole('textbox', { name: /^Secret/ })).toBeNull();
    expect(within(form).queryByLabelText(/Signature header/)).toBeNull();
    const verification = within(form).getByRole('radiogroup', { name: 'Verification' });
    expect(verification).toHaveAccessibleDescription(/Anyone who knows the URL can send events/);

    await user.click(within(form).getByRole('button', { name: 'Create source' }));
    await user.type(await screen.findByRole('textbox', { name: /Reason/ }), 'trying it out');
    await user.click(screen.getByRole('button', { name: 'Create source' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /sources')).toHaveLength(1);
    });
    const body = api.callsTo('POST /sources')[0]?.body as {
      settings: Record<string, unknown>;
      caps: Record<string, unknown>;
    };
    expect(body.settings.verification).toBe('none');
    expect(body.settings).not.toHaveProperty('secret');
    expect(body.caps).not.toHaveProperty('unauthenticated');
  });

  it('requires the secret for an HMAC webhook', async () => {
    const { user, api } = renderWithProviders(<Sources />);
    await user.click(await screen.findByRole('button', { name: 'Add source' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Add a source' })).getByRole('button', {
        name: /^Webhook/,
      }),
    );
    const form = await screen.findByRole('dialog', { name: 'New Webhook source' });
    expect(within(form).getByRole('radio', { name: 'HMAC signature over the body' })).toBeChecked();
    expect(within(form).getByText('Secret').closest('label')).toHaveTextContent('(required)');
    await user.click(within(form).getByRole('button', { name: 'Create source' }));
    expect(within(form).getByText('Some fields need attention')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Reason/ })).toBeNull();

    await user.click(within(form).getByRole('radio', { name: 'Shared-secret header' }));
    expect(within(form).getByRole('textbox', { name: /Shared-secret header/ })).toBeInTheDocument();
    expect(within(form).queryByLabelText(/Signature header/)).toBeNull();
    expect(api.callsTo('POST /sources')).toHaveLength(0);
  });

  it('finds a source type on npm, installs it with a reason and continues into its form', async () => {
    const { user, api } = renderWithProviders(<Sources />, { role: 'admin' });
    await user.click(await screen.findByRole('button', { name: 'Add source' }));
    const picker = await screen.findByRole('dialog', { name: 'Add a source' });
    const npm = within(picker).getByRole('region', { name: 'Find more on npm' });
    const results = await within(npm).findByRole('list', { name: 'npm packages' });
    expect(
      within(results).queryByRole('listitem', { name: 'ai-switchboard-destination-n8n' }),
    ).toBeNull();
    await user.click(
      within(results).getByRole('button', { name: 'Install @ai-switchboard/source-sentry' }),
    );

    const review = await screen.findByRole('dialog', {
      name: 'Install @ai-switchboard/source-sentry',
    });
    expect(await within(review).findByText('sentry.io')).toBeInTheDocument();
    expect(within(review).getByText('sdk ^2.0.0 ok')).toBeInTheDocument();
    await user.click(within(review).getByRole('button', { name: 'Install and continue' }));

    const reason = await screen.findByRole('dialog', {
      name: /^Install @ai-switchboard\/source-sentry@\^1\.2\.0/,
    });
    await user.type(within(reason).getByRole('textbox', { name: /Reason/ }), 'sentry alerts');
    await user.click(within(reason).getByRole('button', { name: 'Install plugin' }));

    await vi.waitFor(() => {
      expect(api.callsTo('POST /plugins')[0]?.body).toEqual({
        package: '@ai-switchboard/source-sentry',
        range: '^1.2.0',
        reason: 'sentry alerts',
      });
    });
    const form = await screen.findByRole('dialog', { name: 'New Sentry source' });
    expect(within(form).getByText('API token')).toBeInTheDocument();
  });

  it('lets operators search npm from Add source but keeps Install for admins', async () => {
    const { user } = renderWithProviders(<Sources />, { role: 'operator' });
    await user.click(await screen.findByRole('button', { name: 'Add source' }));
    const picker = await screen.findByRole('dialog', { name: 'Add a source' });
    const install = await within(picker).findByRole('button', {
      name: 'Install @ai-switchboard/source-sentry',
    });
    expect(install).toHaveAttribute('aria-disabled', 'true');
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
