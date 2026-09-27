import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

    const routines = within(table).getByRole('row', { name: /executor-claude-routines/ });
    expect(within(routines).getByText('0 errors · 2 invalid events · 24 h')).toBeInTheDocument();
    // Baked-in plugins cannot be removed from the UI; installed ones can.
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
    expect(within(dialog).getByText(/unloaded on the next restart/)).toBeInTheDocument();
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
    expect(within(manifest).getByText('sdk ^1.4.0 ok')).toBeInTheDocument();
    expect(api.callsTo('POST /plugins/inspect')[0]?.body).toEqual({
      package: '@ai-switchboard/source-sentry',
      range: '^1',
    });
    expect(api.callsTo('POST /plugins')).toHaveLength(0);
    expect(within(dialog).getByText(/a restart applies it/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Add plugin' }));
    const reason = await screen.findByRole('dialog', {
      name: /Add @ai-switchboard\/source-sentry@\^1/,
    });
    expect(within(reason).getByText(/the next restart loads it/)).toBeInTheDocument();
    await user.type(within(reason).getByRole('textbox', { name: /Reason/ }), 'we moved to Sentry');
    await user.click(within(reason).getByRole('button', { name: 'Add plugin' }));
    await vi.waitFor(() => {
      expect(api.callsTo('POST /plugins')[0]?.body).toEqual({
        package: '@ai-switchboard/source-sentry',
        range: '^1',
        reason: 'we moved to Sentry',
      });
    });
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

  it('adds from the catalogue in one click, through the same inspect and confirm', async () => {
    const { user, api } = renderPlugins('/plugins/catalogue');
    const list = await screen.findByRole('list', { name: 'Catalogue' });
    const linear = within(list).getByRole('listitem', { name: 'Linear' });
    expect(within(linear).getByText('installed')).toBeInTheDocument();
    await user.click(
      within(list).getByRole('button', { name: 'Add @ai-switchboard/source-sentry' }),
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
