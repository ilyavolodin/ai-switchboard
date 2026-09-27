import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderApp } from '../test/render.js';

describe('app shell', () => {
  it('lists the eight sections in order and marks the current one', async () => {
    renderApp('/processes');
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent.replace(/\d+$/, ''))).toEqual([
      'Board',
      'Processes',
      'Sources',
      'Executors',
      'Activity',
      'Approvals',
      'Plugins',
      'Settings',
    ]);
    expect(within(nav).getByRole('link', { name: /Processes/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: /Board/ })).not.toHaveAttribute('aria-current');
  });

  it('shows counts and badges from the API', async () => {
    renderApp('/');
    expect(await screen.findByLabelText('11 processes')).toBeInTheDocument();
    expect(await screen.findByLabelText('2 awaiting approval')).toBeInTheDocument();
    expect(
      await screen.findByRole('img', { name: 'a plugin needs attention' }),
    ).toBeInTheDocument();
    expect(screen.getByText('ilya@lola.com')).toBeInTheDocument();
    expect(screen.getByText('Operator')).toBeInTheDocument();
  });

  it('g p, g a and g b navigate; / focuses search', async () => {
    const { router } = renderApp('/');
    await screen.findByRole('navigation', { name: 'Sections' });
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'p' });
    expect(router.state.location.pathname).toBe('/processes');
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'a' });
    expect(router.state.location.pathname).toBe('/activity');
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'b' });
    expect(router.state.location.pathname).toBe('/');
    fireEvent.keyDown(document, { key: '/' });
    expect(screen.getByRole('searchbox', { name: 'Search by artifact id' })).toHaveFocus();
  });

  it('ignores shortcuts while typing', async () => {
    const { router, user } = renderApp('/');
    const search = await screen.findByRole('searchbox', { name: 'Search by artifact id' });
    await user.click(search);
    await user.keyboard('gp');
    expect(router.state.location.pathname).toBe('/');
  });

  it('routes an artifact search to the Activity trace', async () => {
    const { router, user } = renderApp('/');
    const search = await screen.findByRole('searchbox', { name: 'Search by artifact id' });
    await user.type(search, 'LOL-1712{Enter}');
    expect(router.state.location.pathname).toBe('/activity/trace/LOL-1712');
  });

  it('links the capacity strip, open breakers and pending approvals', async () => {
    renderApp('/');
    expect(await screen.findByRole('link', { name: /1 breaker open/ })).toHaveAttribute(
      'href',
      '/processes?status=breaker',
    );
    expect(screen.getByRole('link', { name: /2 approvals pending/ })).toHaveAttribute(
      'href',
      '/approvals',
    );
    const strip = screen.getByLabelText('Executor capacity');
    expect(
      within(strip).getByRole('link', { name: /5-hour window 62%.*resets in 2 h 10 m/ }),
    ).toHaveAttribute('href', '/executors/ex-routines');
    expect(within(strip).getByRole('link', { name: /API rate limit 18%/ })).toBeInTheDocument();
  });

  it('shows the evaluation banner when OIDC is not configured', async () => {
    renderApp('/');
    expect(
      await screen.findByText('OIDC is not configured — evaluation sign-in'),
    ).toBeInTheDocument();
  });

  it('sends a signed-out person to the sign-in page', async () => {
    const { router } = renderApp('/processes', { role: null });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.getByLabelText(/Email/)).toBeInTheDocument();
  });

  it('shows the OIDC sign-in button in OIDC mode', async () => {
    renderApp('/login', {
      role: null,
      overrides: {
        'GET /auth/me': () => ({
          user: null,
          authMode: 'oidc',
          oidcConfigured: true,
          evaluation: false,
        }),
      },
    });
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/api/v1/auth/oidc/start',
    );
  });

  it('renders placeholders for screens not built yet', async () => {
    renderApp('/sources/src-linear/settings');
    expect(await screen.findByText('Source is coming soon')).toBeInTheDocument();
    expect(screen.getByText('id: src-linear · tab: settings')).toBeInTheDocument();
  });
});
