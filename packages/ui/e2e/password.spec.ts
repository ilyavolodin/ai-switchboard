import { expect, test } from './fixtures.js';

test.use({ signedIn: false });

test('a user with a temporary password must choose their own before reaching the Board', async ({
  page,
  api,
}) => {
  const email = `newcomer-${Date.now()}@acme.test`;
  const temporary = 'temporary-harbour-lamp-1';
  const chosen = 'my-own-quiet-lantern-2';
  await api.post('/api/v1/users', {
    email,
    role: 'operator',
    password: temporary,
    reason: 'e2e: temporary password',
  });

  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByLabel('Password').fill(temporary);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/change-password/);
  await expect(page.getByText('Your password is temporary')).toBeVisible();
  await page.getByLabel('Current password').fill(temporary);
  await page.getByLabel(/^New password/).fill(chosen);
  await page.getByLabel('Confirm new password').fill(chosen);
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByRole('heading', { level: 1, name: /Board/ })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
});
