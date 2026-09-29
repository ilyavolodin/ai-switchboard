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
          evaluationAdminEmail: null,
          requireReasons: true,
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

  it('explains recovery behind "Forgot password or email?"', async () => {
    const { user } = renderApp('/login', {
      overrides: { 'GET /auth/me': () => ({ ...me, user: null }) },
    });
    const toggle = await screen.findByRole('button', { name: 'Forgot password or email?' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Forgot password or email' })).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('region', { name: 'Forgot password or email' });
    expect(panel).toHaveTextContent('Settings › Users');
    expect(panel).toHaveTextContent('switchboard users reset-password <email>');
    expect(panel).toHaveTextContent(
      'docker compose exec switchboard switchboard users reset-password <email>',
    );
    expect(panel).toHaveTextContent('switchboard users list');
    expect(panel).toHaveTextContent('Evaluation admin: admin@switchboard.local');

    await user.click(toggle);
    expect(screen.queryByRole('region', { name: 'Forgot password or email' })).toBeNull();
  });

  it('names no email outside evaluation mode', async () => {
    const { user } = renderApp('/login', {
      overrides: {
        'GET /auth/me': () => ({
          ...me,
          user: null,
          evaluation: false,
          evaluationAdminEmail: null,
        }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Forgot password or email?' }));
    const panel = screen.getByRole('region', { name: 'Forgot password or email' });
    expect(panel).toHaveTextContent('switchboard users reset-password <email>');
    expect(panel).not.toHaveTextContent(/Evaluation admin/);
    expect(panel.textContent).not.toMatch(/@/);
  });
});
