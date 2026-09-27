import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../test/render.js';
import { Settings } from './Settings.js';

const open = () =>
  renderWithProviders(<Settings />, {
    path: '/settings/users',
    routePath: '/settings/:tab?',
    role: 'admin',
  });

async function giveReason(user: ReturnType<typeof open>['user'], reason: string, confirm: string) {
  const field = await screen.findByRole('textbox', { name: /Reason/ });
  const dialog = field.closest<HTMLElement>('[role="dialog"]') ?? document.body;
  await user.type(field, reason);
  await user.click(within(dialog).getByRole('button', { name: confirm }));
}

describe('Users · passwords', () => {
  it('shows how each account signs in', async () => {
    open();
    const table = await screen.findByRole('table', { name: 'Users' });
    const sam = within(table).getByText('sam@lola.com').closest('tr');
    expect(within(sam!).getByText('temporary password')).toBeVisible();
    const daria = within(table).getByText('daria@lola.com').closest('tr');
    expect(within(daria!).getByText('OIDC')).toBeVisible();
  });

  it('sets a password for an OIDC-only account, then asks for a reason', async () => {
    const { user, api } = open();
    const table = await screen.findByRole('table', { name: 'Users' });
    await user.click(
      within(table).getByRole('button', { name: 'Set password for daria@lola.com' }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Set the password for daria/ });
    await user.type(within(dialog).getByRole('textbox', { name: /Temporary password/ }), 'short');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByText(/at least 12 characters/)).toBeVisible();
    expect(api.callsTo('PUT /users/u-daria/password')).toHaveLength(0);

    const field = within(dialog).getByRole('textbox', { name: /Temporary password/ });
    await user.clear(field);
    await user.type(field, 'harbour-lamp-quiet-4');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await giveReason(user, 'needs local sign-in', 'Set password');
    await vi.waitFor(() => {
      expect(api.callsTo('PUT /users/u-daria/password')[0]?.body).toEqual({
        password: 'harbour-lamp-quiet-4',
        reason: 'needs local sign-in',
      });
    });
  });

  it('resets an existing password with a generated one, and never for yourself', async () => {
    const { user, api } = open();
    const table = await screen.findByRole('table', { name: 'Users' });
    expect(
      within(table).getByRole('button', { name: 'Reset password for ilya@lola.com' }),
    ).toHaveAttribute('aria-disabled', 'true');
    await user.click(
      within(table).getByRole('button', { name: 'Reset password for priya@lola.com' }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Reset the password for priya/ });
    await user.click(within(dialog).getByRole('button', { name: 'Generate' }));
    const generated = within(dialog).getByRole<HTMLInputElement>('textbox', {
      name: /Temporary password/,
    }).value;
    expect(generated.length).toBeGreaterThanOrEqual(12);
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await giveReason(user, 'forgot it', 'Set password');
    await vi.waitFor(() => {
      expect(api.callsTo('PUT /users/u-priya/password')[0]?.body).toEqual({
        password: generated,
        reason: 'forgot it',
      });
    });
  });

  it('adds a user with an optional temporary password', async () => {
    const { user, api } = open();
    await screen.findByRole('table', { name: 'Users' });
    await user.type(screen.getByRole('textbox', { name: /Email/ }), 'noor@lola.com');
    await user.type(screen.getByRole('textbox', { name: /Temporary password/ }), 'noor@lola.com');
    await user.click(screen.getByRole('button', { name: 'Add user' }));
    expect(await screen.findByText(/cannot be your email/)).toBeVisible();
    const pw = screen.getByRole('textbox', { name: /Temporary password/ });
    await user.clear(pw);
    await user.type(pw, 'first-day-lantern-8');
    await user.click(screen.getByRole('button', { name: 'Add user' }));
    await giveReason(user, 'new starter', 'Add user');
    await vi.waitFor(() => {
      expect(api.callsTo('POST /users')[0]?.body).toEqual({
        email: 'noor@lola.com',
        role: 'viewer',
        password: 'first-day-lantern-8',
        reason: 'new starter',
      });
    });
  });
});
