import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildFixtures } from '../../api/fixtures.js';
import { renderApp, TEST_NOW } from '../../test/render.js';

const { me } = buildFixtures(TEST_NOW);

describe('Login', () => {
  it('offers only the password form without OIDC', async () => {
    renderApp('/login', { overrides: { 'GET /auth/me': () => ({ ...me, user: null }) } });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Sign in with/ })).not.toBeInTheDocument();
  });

  it('offers the issuer and a local password when OIDC is configured', async () => {
    renderApp('/login', {
      overrides: {
        'GET /auth/me': () => ({
          user: null,
          authMode: 'oidc',
          oidcConfigured: true,
          oidcIssuer: 'accounts.google.com',
          evaluation: false,
          mustChangePassword: false,
        }),
      },
    });
    expect(
      await screen.findByRole('link', { name: 'Sign in with accounts.google.com' }),
    ).toHaveAttribute('href', '/api/v1/auth/oidc/start');
    expect(screen.getByLabelText(/Email/)).toBeVisible();
    expect(screen.getByLabelText(/Password/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(screen.queryByText(/evaluation sign-in/)).not.toBeInTheDocument();
  });

  it('continues to /change-password after signing in with a temporary password', async () => {
    let signedIn = false;
    const { user, router } = renderApp('/login', {
      overrides: {
        'GET /auth/me': () =>
          signedIn ? { ...me, mustChangePassword: true } : { ...me, user: null },
        'POST /auth/login': () => {
          signedIn = true;
          return { ...me, mustChangePassword: true };
        },
      },
    });
    await user.type(await screen.findByLabelText(/Email/), 'ilya@lola.com');
    await user.type(screen.getByLabelText(/Password/), 'temporary-password-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/change-password');
    });
    expect(await screen.findByText('Your password is temporary')).toBeVisible();
  });
});
