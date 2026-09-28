import type {
  InstanceSummary,
  Role,
  SecretProviderDependentDTO,
} from '@ai-switchboard/core/contract';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildFixtures } from '../../api/fixtures.js';
import { mockStatus, type MockHandlers } from '../../api/mockApi.js';
import { TEST_NOW } from '../../test/constants.js';
import { renderApp, renderWithProviders } from '../../test/render.js';
import { Settings } from './Settings.js';

const open = (tab: string, role: Role = 'admin', overrides?: MockHandlers) =>
  renderWithProviders(<Settings />, {
    path: tab ? `/settings/${tab}` : '/settings',
    routePath: '/settings/:tab?',
    role,
    overrides,
  });

async function giveReason(user: ReturnType<typeof open>['user'], reason: string, confirm: string) {
  const field = await screen.findByRole('textbox', { name: /Reason/ });
  const dialog = field.closest<HTMLElement>('[role="dialog"]') ?? document.body;
  await user.type(field, reason);
  await user.click(within(dialog).getByRole('button', { name: confirm }));
}

describe('Settings', () => {
  it('has a tab per section, each a URL', async () => {
    open('');
    const tabs = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(tabs).getByRole('link', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(tabs).getByRole('link', { name: 'Audit log' })).toHaveAttribute(
      'href',
      '/settings/audit',
    );
    expect(await screen.findByRole('combobox', { name: /Timezone/ })).toHaveValue(
      'America/New_York',
    );
  });

  it('turns "Require a reason for every change" off (admin, with a reason)', async () => {
    const { user, api } = open('');
    const toggle = await screen.findByRole('switch', { name: /Require a reason for every change/ });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(screen.getByText(/audited as “\(no reason given\)”/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await giveReason(user, 'small team, audit trail is enough', 'Save settings');
    await vi.waitFor(() => {
      expect(api.callsTo('PUT /settings')[0]?.body).toEqual({
        settings: { requireReasons: false },
        reason: 'small team, audit trail is enough',
      });
    });
  });

  it('keeps the reasons switch read-only for an operator', async () => {
    open('', 'operator');
    const toggle = await screen.findByRole('switch', { name: /Require a reason for every change/ });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
  });

  it('saves general settings with a reason, sending only what changed', async () => {
    const { user, api } = open('');
    const staleness = await screen.findByRole('textbox', { name: /Meter staleness/ });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    await user.clear(staleness);
    await user.type(staleness, '20');
    await user.selectOptions(screen.getByRole('combobox', { name: /System notifier/ }), '');
    // Enabling swaps the tooltip wrapper out, so query the button again.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await giveReason(user, 'meters poll every 10 min now', 'Save settings');
    await vi.waitFor(() => {
      expect(api.callsTo('PUT /settings')[0]?.body).toEqual({
        settings: { meterStalenessMinutes: 20, systemNotifierId: null },
        reason: 'meters poll every 10 min now',
      });
    });
  });

  it('refuses an invalid number before asking for a reason', async () => {
    const { user } = open('');
    const staleness = await screen.findByRole('textbox', { name: /Meter staleness/ });
    await user.clear(staleness);
    await user.type(staleness, 'soon');
    expect(screen.getByText('Enter a whole number of minutes')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('lets a viewer read settings but not save them', async () => {
    open('', 'viewer');
    expect(await screen.findByRole('combobox', { name: /Timezone/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('warns when OIDC is not configured and saves sign-in with a reason', async () => {
    const { user, api } = open('sign-in');
    expect(await screen.findByText('OIDC is not configured')).toBeVisible();
    expect(screen.getByText('OIDC_CLIENT_SECRET')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: /Issuer/ }), 'https://accounts.google.com');
    await user.type(screen.getByRole('textbox', { name: /Client id/ }), 'client-123');
    await user.type(screen.getByRole('textbox', { name: /Allowed domains/ }), 'lola.com, acme.io');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await giveReason(user, 'turn on Google sign-in', 'Save sign-in');
    await vi.waitFor(() => {
      expect(api.callsTo('PUT /settings')[0]?.body).toEqual({
        settings: {
          oidc: {
            issuer: 'https://accounts.google.com',
            clientId: 'client-123',
            allowedDomains: ['lola.com', 'acme.io'],
          },
        },
        reason: 'turn on Google sign-in',
      });
    });
  });

  describe('Users', () => {
    it('shows an operator the users read-only, every control disabled and naming the role', async () => {
      const { api } = open('users', 'operator');
      const table = await screen.findByRole('table', { name: 'Users' });
      expect(within(table).getByText('daria@lola.com')).toBeInTheDocument();
      expect(
        within(table).getByRole('combobox', { name: 'Role for daria@lola.com' }),
      ).toBeDisabled();
      const remove = within(table).getByRole('button', { name: 'Remove daria@lola.com' });
      expect(remove).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByRole('button', { name: 'Add user' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(screen.getByRole('textbox', { name: 'Email' })).toBeDisabled();
      expect(
        screen.getByText(/adding people and changing roles needs the Admin role/),
      ).toBeVisible();
      // Only the directory (email and role): the admin list is never requested.
      expect(api.callsTo('GET /users/directory')).toHaveLength(1);
      expect(api.callsTo('GET /users')).toHaveLength(0);
    });

    it('changes a role, adds and removes users with reasons', async () => {
      const { user, api } = open('users', 'admin');
      const table = await screen.findByRole('table', { name: 'Users' });
      expect(
        within(table).getByRole('combobox', { name: 'Role for ilya@lola.com' }),
      ).toBeDisabled();
      expect(within(table).getByRole('button', { name: 'Remove ilya@lola.com' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );

      await user.selectOptions(
        within(table).getByRole('combobox', { name: 'Role for daria@lola.com' }),
        'viewer',
      );
      await giveReason(user, 'moved teams', 'Change role');
      await vi.waitFor(() => {
        expect(api.callsTo('PUT /users/u-daria')[0]?.body).toEqual({
          role: 'viewer',
          reason: 'moved teams',
        });
      });

      await user.click(within(table).getByRole('button', { name: 'Remove sam@lola.com' }));
      await giveReason(user, 'left the company', 'Remove user');
      await vi.waitFor(() => {
        expect(api.callsTo('DELETE /users/u-sam')[0]?.body).toEqual({ reason: 'left the company' });
      });

      await user.click(
        within(table).getByRole('button', { name: 'Revoke sessions for priya@lola.com' }),
      );
      await giveReason(user, 'lost laptop', 'Revoke sessions');
      await vi.waitFor(() => {
        expect(api.callsTo('POST /users/u-priya/sessions/revoke')).toHaveLength(1);
      });

      await user.type(screen.getByRole('textbox', { name: /Email/ }), 'noor@lola.com');
      await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'operator');
      await user.click(screen.getByRole('button', { name: 'Add user' }));
      await giveReason(user, 'joins the platform team', 'Add user');
      await vi.waitFor(() => {
        expect(api.callsTo('POST /users')[0]?.body).toEqual({
          email: 'noor@lola.com',
          role: 'operator',
          reason: 'joins the platform team',
        });
      });
    });
  });

  describe('API tokens', () => {
    it('shows the secret once after creating a token', async () => {
      const { user, api } = open('tokens', 'operator');
      await screen.findByRole('table', { name: 'API tokens' });
      const role = screen.getByRole('combobox', { name: 'Role' });
      expect(within(role).queryByRole('option', { name: 'Admin' })).not.toBeInTheDocument();
      await user.type(screen.getByRole('textbox', { name: /Name/ }), 'laptop CLI');
      await user.selectOptions(role, 'operator');
      await user.click(screen.getByRole('button', { name: 'Create token' }));
      await giveReason(user, 'switchboard apply from my laptop', 'Create token');

      const dialog = await screen.findByRole('dialog', { name: 'Copy your token now' });
      expect(within(dialog).getByLabelText('Token secret')).toHaveTextContent('sb_fixture-secret');
      expect(api.callsTo('POST /tokens')[0]?.body).toEqual({
        name: 'laptop CLI',
        role: 'operator',
        reason: 'switchboard apply from my laptop',
      });
      const write = vi.spyOn(navigator.clipboard, 'writeText');
      await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
      expect(write).toHaveBeenCalledWith('sb_fixture-secret');

      await user.click(within(dialog).getByRole('button', { name: 'Done' }));
      expect(screen.queryByText('sb_fixture-secret')).not.toBeInTheDocument();
    });

    it('revokes a token with a reason', async () => {
      const { user, api } = open('tokens', 'viewer');
      await user.click(await screen.findByRole('button', { name: 'Revoke CI apply' }));
      await giveReason(user, 'rotating', 'Revoke token');
      await vi.waitFor(() => {
        expect(api.callsTo('DELETE /tokens/tok-ci')[0]?.body).toEqual({ reason: 'rotating' });
      });
    });
  });

  describe('Notifiers and secret providers', () => {
    it('sends a test notification and reloads with reasons', async () => {
      const { user, api } = open('notifiers');
      await user.click(
        await screen.findByRole('button', { name: 'Send a test notification to Slack — #loops' }),
      );
      await giveReason(user, 'check the new channel', 'Send test');
      await vi.waitFor(() => {
        expect(api.callsTo('POST /notifiers/n-slack/test')[0]?.body).toEqual({
          reason: 'check the new channel',
        });
      });
    });

    it('creates a secret provider from its schema form', async () => {
      const { user, api } = open('secret-providers');
      await user.click(await screen.findByRole('button', { name: 'Add secret provider' }));
      const drawer = screen.getByRole('dialog', { name: 'Add a secret provider' });
      await user.selectOptions(within(drawer).getByRole('combobox', { name: /Type/ }), 'file');
      await user.type(within(drawer).getByRole('textbox', { name: /^Name/ }), 'mounted');
      await user.type(within(drawer).getByRole('textbox', { name: /Directory/ }), '/run/secrets');
      await user.click(within(drawer).getByRole('button', { name: 'Add secret provider' }));
      await giveReason(user, 'kubernetes secrets', 'Add secret provider');
      await vi.waitFor(() => {
        expect(api.callsTo('POST /secret-providers')[0]?.body).toEqual({
          typeId: 'file',
          name: 'mounted',
          settings: { directory: '/run/secrets' },
          enabled: true,
          reason: 'kubernetes secrets',
        });
      });
    });

    it('offers the configured secret providers in a notifier’s secret fields', async () => {
      const { secretProviders } = buildFixtures(TEST_NOW);
      const env = secretProviders[0];
      if (!env) throw new Error('fixture env provider missing');
      const { user } = open('notifiers', 'admin', {
        'GET /secret-providers': () => [
          ...secretProviders,
          { ...env, id: 'sp-vault', typeId: 'vault', name: 'vault' },
        ],
      });
      await user.click(await screen.findByRole('button', { name: 'Edit Slack — #loops' }));
      const drawer = screen.getByRole('dialog', { name: 'Edit Slack — #loops' });
      const provider = within(drawer).getByRole('combobox', { name: /provider/ });
      await vi.waitFor(() => {
        expect(within(provider).getByRole('option', { name: 'vault' })).toBeInTheDocument();
      });
    });

    it('shows who uses a secret provider and the refreshed status after enabling it', async () => {
      const { secretProviders } = buildFixtures(TEST_NOW);
      const env = secretProviders[0];
      if (!env) throw new Error('fixture env provider missing');
      const failing: SecretProviderDependentDTO = {
        kind: 'source',
        id: 's-github',
        name: 'GitHub',
        status: { tone: 'error', label: 'error' },
        instanceError: 'secret_error: secret provider "env" is not configured or not running',
      };
      const broken: InstanceSummary = { ...env, enabled: false, dependents: [failing] };
      let current = broken;
      const { user } = open('secret-providers', 'admin', {
        'GET /secret-providers': () => [current],
        'POST /secret-providers/:id/enable': () => {
          current = {
            ...broken,
            enabled: true,
            dependents: [{ ...failing, status: { tone: 'ok', label: 'ok' }, instanceError: null }],
          };
          return current;
        },
      });
      const usage = await screen.findByRole('region', { name: 'Instances using env' });
      expect(within(usage).getByText(/secret_error/)).toBeInTheDocument();
      await user.click(screen.getByRole('switch', { name: 'Enabled' }));
      await giveReason(user, 'turn env back on', 'Enable');
      await vi.waitFor(() => {
        expect(
          within(screen.getByRole('region', { name: 'Instances using env' })).queryByText(
            /secret_error/,
          ),
        ).not.toBeInTheDocument();
      });
      expect(within(usage).getByRole('link', { name: 'GitHub' })).toHaveAttribute(
        'href',
        '/sources/s-github',
      );
    });

    it('explains a refused delete of a secret provider in use', async () => {
      const { user } = open('secret-providers', 'admin', {
        'DELETE /secret-providers/:id': () =>
          mockStatus(409, {
            error: 'conflict',
            message: 'Still used by executor "Claude Routines — automation seat".',
          }),
      });
      await user.click(await screen.findByRole('button', { name: 'Delete env' }));
      await giveReason(user, 'clean up', 'Delete');
      const row = screen.getByRole('listitem', { name: 'env' });
      expect(await within(row).findByText('env was not deleted')).toBeInTheDocument();
      expect(within(row).getByText(/Still used by executor/)).toBeInTheDocument();
    });

    it('links the processes that still notify through a notifier it refused to delete', async () => {
      const { user } = open('notifiers', 'admin', {
        'DELETE /notifiers/:id': () =>
          mockStatus(409, {
            error: 'conflict',
            message: 'Still used by Autofix.',
            usedBy: [{ id: 'p-autofix', name: 'Autofix' }],
          }),
      });
      await user.click(await screen.findByRole('button', { name: 'Delete Slack — #loops' }));
      await giveReason(user, 'clean up', 'Delete');
      expect(await screen.findByText('Slack — #loops is still in use')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Autofix' })).toHaveAttribute(
        'href',
        '/processes/p-autofix/edit',
      );
      expect(screen.queryByText('Slack — #loops was not deleted')).toBeNull();
    });

    it('keeps admin actions disabled for an operator', async () => {
      open('notifiers', 'operator');
      expect(await screen.findByRole('button', { name: 'Delete Slack — #loops' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Add notifier' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
  });

  it('saves retention days with a reason', async () => {
    const { user, api } = open('retention');
    const raw = await screen.findByRole('textbox', { name: /Raw bodies/ });
    await user.clear(raw);
    await user.type(raw, '3');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await giveReason(user, 'less internal text at rest', 'Save retention');
    await vi.waitFor(() => {
      const body = api.callsTo('PUT /settings')[0]?.body as {
        settings: { retention: { rawBodiesDays: number; eventsDays: number } };
      };
      expect(body.settings.retention.rawBodiesDays).toBe(3);
      expect(body.settings.retention.eventsDays).toBe(30);
    });
  });

  it('previews an apply as a dry run, then applies with a reason', async () => {
    const changes = [
      { kind: 'process', name: 'Autofix', action: 'update' },
      { kind: 'source', name: 'Sentry', action: 'create' },
      { kind: 'executor', name: 'HTTP', action: 'unchanged' },
    ];
    const { user, api } = open('export', 'admin', {
      'POST /apply': (r) => ({
        dryRun: (r.body as { dryRun?: boolean }).dryRun === true,
        changes,
        errors: [],
      }),
    });
    const apply = await screen.findByRole('button', { name: 'Apply' });
    expect(apply).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('textbox', { name: /Configuration/ }));
    await user.paste('processes: []');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    const list = await screen.findByRole('list', { name: 'Changes the dry run found' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('Autofix')).toBeVisible();
    expect(screen.getByText('1 unchanged')).toBeVisible();
    expect(api.callsTo('POST /apply')[0]?.body).toMatchObject({
      yaml: 'processes: []',
      dryRun: true,
    });

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply this configuration?' });
    expect(dialog).toHaveTextContent('1 to create, 1 to update');
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'sync from git');
    await user.click(within(dialog).getByRole('button', { name: 'Apply configuration' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /apply')[1]?.body).toEqual({
        yaml: 'processes: []',
        dryRun: false,
        reason: 'sync from git',
      });
    });
    expect(await screen.findByText(/1 created, 1 updated/)).toBeVisible();
  });

  it('downloads the YAML export', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:switchboard');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockReturnValue(undefined);
    const { user, api } = open('export', 'operator');
    await user.click(await screen.findByRole('button', { name: 'Download YAML' }));
    await vi.waitFor(() => {
      expect(click).toHaveBeenCalled();
    });
    expect(api.callsTo('GET /export')).toHaveLength(1);
    expect(create).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:switchboard');
    vi.restoreAllMocks();
  });

  it('shows versions and replicas on About', async () => {
    open('about', 'viewer');
    const replicas = await screen.findByRole('list', { name: 'Replicas' });
    expect(within(replicas).getAllByText('live')).toHaveLength(2);
    expect(screen.getByText('switchboard 0.4.1 · sdk 1.4.2')).toBeVisible();
    expect(screen.getByRole('link', { name: 'https://switchboard.lola.com' })).toHaveAttribute(
      'target',
      '_blank',
    );
  });

  describe('Audit log', () => {
    it('shows each change as before → after with who and why', async () => {
      open('audit', 'viewer');
      const table = await screen.findByRole('table', { name: 'Audit log' });
      const row = within(table).getByRole('row', { name: /budgets\.runsPerHour/ });
      expect(row).toHaveTextContent('ilya@lola.com');
      expect(row).toHaveTextContent('Autofix');
      expect(row).toHaveTextContent('4→ changed to 2');
      expect(row).toHaveTextContent('lower runs per hour to 2');
      expect(within(table).getByRole('row', { name: /Slack — Events API/ })).toHaveTextContent(
        'true→ changed to false',
      );
    });

    it('diffs object values key by key', async () => {
      open('audit', 'viewer', {
        'GET /audit': () => ({
          items: [
            {
              id: 1,
              at: '2026-09-27T10:00:00Z',
              actor: 'daria@lola.com',
              scope: 'process',
              targetId: 'p-autofix',
              targetName: 'Autofix',
              field: 'batching',
              before: { debounceSeconds: 60, maxSize: 5 },
              after: { debounceSeconds: 90, maxSize: 5 },
              reason: 'fewer half-batches',
            },
          ],
          nextCursor: null,
        }),
      });
      const table = await screen.findByRole('table', { name: 'Audit log' });
      const row = within(table).getByRole('row', { name: /batching/ });
      expect(row).toHaveTextContent('debounceSeconds: 60→ changed to 90');
      expect(row).not.toHaveTextContent('maxSize');
    });

    it('filters by scope and actor', async () => {
      const seen: URLSearchParams[] = [];
      const { user, router } = open('audit', 'viewer', {
        'GET /audit': (r) => {
          seen.push(new URLSearchParams(r.query));
          return { items: [], nextCursor: null };
        },
      });
      await user.selectOptions(await screen.findByRole('combobox', { name: 'Scope' }), 'process');
      await vi.waitFor(() => {
        expect(seen.at(-1)?.get('scope')).toBe('process');
      });
      await user.type(screen.getByRole('textbox', { name: 'Actor' }), 'daria@lola.com{Enter}');
      await vi.waitFor(() => {
        expect(seen.at(-1)?.get('actor')).toBe('daria@lola.com');
      });
      expect(router.state.location.search).toBe('?scope=process&actor=daria%40lola.com');
      expect(await screen.findByText('No changes match these filters.')).toBeVisible();
    });
  });

  it('is routed at /settings/:tab', async () => {
    renderApp('/settings/audit', { role: 'admin' });
    expect(await screen.findByRole('table', { name: 'Audit log' })).toBeVisible();
  });
});
