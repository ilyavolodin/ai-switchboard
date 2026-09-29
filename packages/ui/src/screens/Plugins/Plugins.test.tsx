import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { mockStatus } from '../../api/mockApi.js';
import type { RenderOptions } from '../../test/render.js';
import { renderWithProviders } from '../../test/render.js';
import { Plugins } from './Plugins.js';

function renderPlugins(path = '/plugins', options: RenderOptions = {}) {
  return renderWithProviders(<Plugins />, {
    path,
    routePath: path === '/plugins' ? '/plugins' : '/plugins/:tab',
    role: 'admin',
    ...options,
  });
}

describe('Plugins', () => {
  it('lists installed plugins with version, types, capabilities and health', async () => {
    renderPlugins();
    const table = await screen.findByRole('table', { name: 'Installed plugins' });
    const row = within(table).getByRole('row', { name: /@ai-switchboard\/source-linear/ });
    expect(within(row).getByText('1.4.2')).toBeInTheDocument();
    expect(within(row).getByText('api.linear.app')).toBeInTheDocument();
    expect(within(row).getByText('LINEAR_*')).toBeInTheDocument();
    expect(within(row).getByText('loaded')).toHaveAttribute('data-tone', 'ok');
    expect(within(row).getByText('linear')).toBeInTheDocument();

    const routines = within(table).getByRole('row', { name: /destination-claude-routines/ });
    expect(within(routines).getByText('0 errors · 2 invalid events · 24 h')).toBeInTheDocument();
    expect(within(routines).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(
      screen.getByText(/@lola\/switchboard-source-braintrust unavailable · failed to load/),
    ).toBeInTheDocument();
  });

  it('removes an installed plugin with a reason, naming the restart', async () => {
    const { user, api } = renderPlugins();
    await user.click(
      await screen.findByRole('button', { name: 'Remove @lola/switchboard-source-braintrust' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/every replica removes its copy/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'unmaintained');
    await user.click(within(dialog).getByRole('button', { name: 'Remove plugin' }));
    await vi.waitFor(() => {
      expect(
        api.callsTo(
          `DELETE /plugins/${encodeURIComponent('@lola/switchboard-source-braintrust')}`,
        )[0]?.body,
      ).toEqual({
        reason: 'unmaintained',
      });
    });
  });

  it('shows the manifest capabilities and compatibility before anything is installed', async () => {
    const { user, api } = renderPlugins();
    await user.click(await screen.findByRole('button', { name: 'Add plugin' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add plugin' });
    const add = within(dialog).getByRole('button', { name: 'Add plugin' });
    expect(add).toHaveAttribute('aria-disabled', 'true');

    await user.type(
      within(dialog).getByLabelText(/Package and version range/),
      '@ai-switchboard/source-sentry@^1',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Inspect' }));
    const manifest = await within(dialog).findByRole('region', { name: 'Manifest' });
    expect(within(manifest).getByText('sentry.io')).toBeInTheDocument();
    expect(within(manifest).getByText('SENTRY_*')).toBeInTheDocument();
    expect(within(manifest).getByText('Sentry source')).toBeInTheDocument();
    expect(within(manifest).getByText('sdk ^2.0.0 ok')).toBeInTheDocument();
    expect(api.callsTo('POST /plugins/inspect')[0]?.body).toEqual({
      package: '@ai-switchboard/source-sentry',
      range: '^1',
    });
    expect(api.callsTo('POST /plugins')).toHaveLength(0);
    expect(within(dialog).getByText(/installs and loads it/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Add plugin' }));
    const reason = await screen.findByRole('dialog', {
      name: /Add @ai-switchboard\/source-sentry@\^1/,
    });
    expect(within(reason).getByText(/loaded now/)).toBeInTheDocument();
    await user.type(within(reason).getByRole('textbox', { name: /Reason/ }), 'we moved to Sentry');
    await user.click(within(reason).getByRole('button', { name: 'Add plugin' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /plugins')[0]?.body).toEqual({
        package: '@ai-switchboard/source-sentry',
        range: '^1',
        reason: 'we moved to Sentry',
      });
    });
    expect(await screen.findByText('Added · ready to use')).toBeInTheDocument();
    expect(screen.queryByText(/restart to apply/)).toBeNull();
  });

  it('says so when an upgrade of a loaded plugin needs a restart', async () => {
    const { user } = renderPlugins('/plugins', {
      overrides: {
        'POST /plugins': (r) => ({
          ...(r.body as object),
          name: '@ai-switchboard/source-linear',
          pluginId: 'linear',
          displayName: 'Linear',
          version: '1.4.2',
          status: 'loaded',
          statusLabel: { tone: 'warn', label: 'restart to apply' },
          statusMessage: 'Version 1.5.0 is installed; restart to load it.',
          origin: 'installed',
          sdkRange: '^1.0.0',
          capabilities: {},
          types: [],
          errorCount: 0,
          invalidEventCount: 0,
          integrity: null,
          pendingRestart: true,
        }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Add plugin' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add plugin' });
    await user.type(
      within(dialog).getByLabelText(/Package and version range/),
      '@ai-switchboard/source-linear@^1.5',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Inspect' }));
    await within(dialog).findByRole('region', { name: 'Manifest' });
    await user.click(within(dialog).getByRole('button', { name: 'Add plugin' }));
    const reason = await screen.findByRole('dialog', {
      name: /^Add @ai-switchboard\/source-linear/,
    });
    await user.type(within(reason).getByRole('textbox', { name: /Reason/ }), 'upgrade');
    await user.click(within(reason).getByRole('button', { name: 'Add plugin' }));
    expect(await screen.findByText('Added · restart to apply')).toBeInTheDocument();
  });

  it('refuses an incompatible package', async () => {
    const { user, api } = renderPlugins('/plugins', {
      overrides: {
        'POST /plugins/inspect': () => ({
          package: 'old-plugin',
          version: '0.3.0',
          sdkRange: '^0.8.0',
          compatible: false,
          capabilities: {},
          types: [],
          integrity: null,
        }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Add plugin' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add plugin' });
    await user.type(within(dialog).getByLabelText(/Package and version range/), 'old-plugin');
    await user.click(within(dialog).getByRole('button', { name: 'Inspect' }));
    expect(await within(dialog).findByText('incompatible · sdk ^0.8.0')).toBeInTheDocument();
    const add = within(dialog).getByRole('button', { name: 'Add plugin' });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    await user.click(add);
    expect(api.callsTo('POST /plugins')).toHaveLength(0);
  });

  it('browses npm by kind and text, with reviewed and installed state', async () => {
    const { user } = renderPlugins('/plugins/browse');
    const list = await screen.findByRole('list', { name: 'npm packages' });
    const sentry = within(list).getByRole('listitem', { name: '@ai-switchboard/source-sentry' });
    expect(within(sentry).getByText('reviewed')).toHaveAttribute('data-tone', 'ok');
    expect(within(sentry).getByText('1.2k / week')).toBeInTheDocument();
    expect(within(sentry).getByRole('link', { name: /npm/ })).toHaveAttribute('rel', 'noreferrer');
    const linear = within(list).getByRole('listitem', { name: '@ai-switchboard/source-linear' });
    expect(within(linear).getByText('installed · 1.4.2')).toBeInTheDocument();
    expect(within(linear).queryByRole('button', { name: /Install/ })).toBeNull();
    const jira = within(list).getByRole('listitem', { name: '@acme/ai-switchboard-source-jira' });
    expect(within(jira).queryByText('reviewed')).toBeNull();
    expect(within(jira).getByText(/by acme-dev/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Destinations' }));
    expect(
      await screen.findByRole('listitem', { name: 'ai-switchboard-destination-n8n' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: '@ai-switchboard/source-sentry' })).toBeNull();

    await user.click(screen.getByRole('radio', { name: 'All' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search npm' }), 'jira');
    await vi.waitFor(() => {
      expect(screen.queryByRole('listitem', { name: '@ai-switchboard/source-sentry' })).toBeNull();
    });
    expect(
      screen.getByRole('listitem', { name: '@acme/ai-switchboard-source-jira' }),
    ).toBeInTheDocument();
  });

  it('installs from Browse npm through the same inspect, review and reason', async () => {
    const { user, api } = renderPlugins('/plugins/browse');
    const list = await screen.findByRole('list', { name: 'npm packages' });
    await user.click(
      within(list).getByRole('button', { name: 'Install @ai-switchboard/source-sentry' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Add plugin' });
    expect(within(dialog).getByLabelText(/Package and version range/)).toHaveValue(
      '@ai-switchboard/source-sentry@^1.2.0',
    );
    expect(await within(dialog).findByText('sentry.io')).toBeInTheDocument();
    expect(api.callsTo('POST /plugins/inspect')[0]?.body).toEqual({
      package: '@ai-switchboard/source-sentry',
      range: '^1.2.0',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Add plugin' }));
    const reason = await screen.findByRole('dialog', {
      name: /^Add @ai-switchboard\/source-sentry/,
    });
    await user.type(within(reason).getByRole('textbox', { name: /Reason/ }), 'sentry alerts');
    await user.click(within(reason).getByRole('button', { name: 'Add plugin' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /plugins')[0]?.body).toEqual({
        package: '@ai-switchboard/source-sentry',
        range: '^1.2.0',
        reason: 'sentry alerts',
      });
    });
    expect(await screen.findByText('Added · ready to use')).toBeInTheDocument();
  });

  it('says plainly when the registry cannot be reached', async () => {
    renderPlugins('/plugins/browse', {
      overrides: {
        'GET /plugins/search': () =>
          mockStatus(503, {
            error: 'registry_unavailable',
            message: 'The npm registry at https://registry.npmjs.org is unreachable (offline).',
          }),
      },
    });
    expect(await screen.findByText('npm could not be searched')).toBeInTheDocument();
    expect(screen.getByText(/is unreachable/)).toBeInTheDocument();
  });

  it('lets viewers search npm but not install', async () => {
    renderPlugins('/plugins/browse', { role: 'viewer' });
    const list = await screen.findByRole('list', { name: 'npm packages' });
    expect(
      within(list).getByRole('button', { name: 'Install @ai-switchboard/source-sentry' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps admin actions visible but disabled for operators', async () => {
    renderPlugins('/plugins', { role: 'operator' });
    expect(await screen.findByRole('button', { name: 'Add plugin' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      await screen.findByRole('button', { name: 'Remove @lola/switchboard-source-braintrust' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });
});
