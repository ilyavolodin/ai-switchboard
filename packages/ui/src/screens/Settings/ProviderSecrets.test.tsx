import type { Role } from '@ai-switchboard/core/contract';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { MockHandlers } from '../../api/mockApi.js';
import { renderWithProviders } from '../../test/render.js';
import { Settings } from './Settings.js';

const open = (role: Role = 'admin', overrides?: MockHandlers) =>
  renderWithProviders(<Settings />, {
    path: '/settings/secret-providers',
    routePath: '/settings/:tab?',
    role,
    overrides,
  });

async function showSecrets(r: ReturnType<typeof open>, provider = 'env') {
  const toggle = await screen.findByRole('button', { name: `Show secrets in ${provider}` });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await r.user.click(toggle);
  return screen.findByRole('region', { name: `Secrets in ${provider}` });
}

describe('Settings › Secret providers › Secrets', () => {
  it('lists names with a copyable reference, who uses each, and when it changed', async () => {
    const r = open();
    const panel = await showSecrets(r);
    const table = await within(panel).findByRole('table', { name: 'Secrets in env' });
    const row = within(table).getByRole('row', { name: /LINEAR_API_KEY/ });
    expect(within(row).getByText('secret://env/LINEAR_API_KEY')).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: 'Copy secret://env/LINEAR_API_KEY' }),
    ).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Linear — lola' })).toHaveAttribute(
      'href',
      '/sources/src-linear',
    );
    expect(within(table).getByRole('row', { name: /SPARE_TOKEN/ })).toHaveTextContent('not used');
    expect(r.api.callsTo('GET /secret-providers/sp-env/secrets')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Hide secrets in env' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('labels names the host stored for an instance and offers no reference to copy', async () => {
    const r = open();
    const panel = await showSecrets(r, 'file — /var/run/secrets');
    const table = await within(panel).findByRole('table', {
      name: 'Secrets in file — /var/run/secrets',
    });
    const row = within(table).getByRole('row', { name: /oauthRefreshToken/ });
    expect(row).toHaveTextContent('stored by Claude Routines — automation seat');
    expect(
      within(row).getByRole('link', { name: 'Claude Routines — automation seat' }),
    ).toHaveAttribute('href', '/destinations/dst-routines');
    expect(within(row).queryByRole('button', { name: /^Copy/ })).toBeNull();
    expect(within(table).getByRole('row', { name: /github-app-key/ })).toHaveTextContent(
      'secret://file/github-app-key',
    );
  });

  it('flags references whose names the provider does not list', async () => {
    const r = open();
    const panel = await showSecrets(r);
    const missing = await within(panel).findByRole('list', { name: 'Missing from env' });
    expect(
      within(missing).getByText('secret://env/LOOPS_ROUTINE_TOKEN_AUTOFIX'),
    ).toBeInTheDocument();
    expect(within(missing).getByText('missing')).toBeInTheDocument();
    expect(within(missing).getByRole('link', { name: 'Autofix' })).toHaveAttribute(
      'href',
      '/processes/p-autofix',
    );
  });

  it('explains a provider that cannot list', async () => {
    const r = open('admin', {
      'GET /secret-providers/:id/secrets': () => ({
        providerId: 'sp-env',
        provider: 'env',
        available: false,
        error: 'The Vault provider type cannot list its secrets.',
        secrets: [],
        missing: [],
      }),
    });
    const panel = await showSecrets(r);
    expect(
      await within(panel).findByText('This provider cannot list its secrets'),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/Vault provider type cannot list/)).toBeInTheDocument();
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an empty listing', async () => {
    const r = open('admin', {
      'GET /secret-providers/:id/secrets': () => ({
        providerId: 'sp-env',
        provider: 'env',
        available: true,
        secrets: [],
        missing: [],
      }),
    });
    const panel = await showSecrets(r);
    expect(await within(panel).findByText('The provider lists no secrets.')).toBeInTheDocument();
  });

  it('is admin only: an operator cannot open it', async () => {
    const r = open('operator');
    const toggle = await screen.findByRole('button', { name: 'Show secrets in env' });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await r.user.click(toggle);
    expect(screen.queryByRole('region', { name: 'Secrets in env' })).not.toBeInTheDocument();
    expect(r.api.callsTo('GET /secret-providers/sp-env/secrets')).toHaveLength(0);
  });
});
