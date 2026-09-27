import { expect, test } from './fixtures.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './stack.js';

test.use({ signedIn: false, allowedApiErrors: [/^401 POST \/api\/v1\/auth\/login$/] });

test('signing in with the local admin lands on the Board; signing out returns to sign-in', async ({
  page,
}) => {
  await page.goto('/processes');
  await expect(page).toHaveURL(/\/login/);

  await page.getByRole('textbox', { name: 'Email' }).fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Processes|Board/ })).toBeVisible();
  await expect(page.getByText(ADMIN_EMAIL.slice(0, 9))).toBeVisible();

  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
});
