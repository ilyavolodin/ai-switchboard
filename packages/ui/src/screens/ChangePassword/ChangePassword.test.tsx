import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { mockStatus } from '../../api/mockApi.js';
import { buildFixtures } from '../../api/fixtures.js';
import { renderApp, TEST_NOW } from '../../test/render.js';

const { me } = buildFixtures(TEST_NOW);
const restricted = () => ({ ...me, mustChangePassword: true });

describe('Change password', () => {
  it('sends a session with a temporary password from any screen to /change-password', async () => {
    const { router } = renderApp('/processes', {
      overrides: { 'GET /auth/me': restricted },
    });
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/change-password');
    });
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Password rules' })).toBeVisible();
  });

  it('validates before sending, then continues where the person was going', async () => {
    let changed = false;
    const { user, api, router } = renderApp('/processes', {
      overrides: {
        'GET /auth/me': () => (changed ? me : restricted()),
        'POST /auth/password': () => {
          changed = true;
          return me;
        },
      },
    });
    await screen.findByRole('heading', { name: 'Choose a new password' });
    const submit = screen.getByRole('button', { name: 'Save and continue' });

    await user.click(submit);
    expect(screen.getByText('Enter your current password.')).toBeVisible();
    expect(screen.getByText(/at least 8 characters/)).toBeVisible();

    await user.type(screen.getByLabelText(/^Current password/), 'temporary-password-1');
    await user.type(screen.getByLabelText(/^New password/), 'ilya@lola.com');
    await user.click(submit);
    expect(screen.getByText(/cannot be your email/)).toBeVisible();

    await user.clear(screen.getByLabelText(/^New password/));
    await user.type(screen.getByLabelText(/^New password/), 'my-own-quiet-harbour-9');
    await user.type(screen.getByLabelText(/^Confirm new password/), 'my-own-quiet-harbour-8');
    await user.click(submit);
    expect(screen.getByText('The passwords do not match.')).toBeVisible();
    expect(api.callsTo('POST /auth/password')).toHaveLength(0);

    await user.clear(screen.getByLabelText(/^Confirm new password/));
    await user.type(screen.getByLabelText(/^Confirm new password/), 'my-own-quiet-harbour-9');
    await user.click(submit);
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/processes');
    });
    expect(api.callsTo('POST /auth/password')[0]?.body).toEqual({
      currentPassword: 'temporary-password-1',
      newPassword: 'my-own-quiet-harbour-9',
    });
  });

  it('shows the server’s refusal (a wrong current password)', async () => {
    const { user } = renderApp('/change-password', {
      overrides: {
        'POST /auth/password': () =>
          mockStatus(400, {
            error: 'invalid_credentials',
            message: 'The current password is incorrect.',
          }),
      },
    });
    await screen.findByRole('heading', { name: 'Change password' });
    await user.type(screen.getByLabelText(/^Current password/), 'wrong-password-1');
    await user.type(screen.getByLabelText(/^New password/), 'my-own-quiet-harbour-9');
    await user.type(screen.getByLabelText(/^Confirm new password/), 'my-own-quiet-harbour-9');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The current password is incorrect.')).toBeVisible();
  });
});
