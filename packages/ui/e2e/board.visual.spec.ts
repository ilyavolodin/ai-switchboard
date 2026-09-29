// Baselines are of the freshly seeded stack: one breaker open, one approval waiting, one healthy
// process.
import { expect, open, test } from './fixtures.js';
import { BREAKER_PROCESS } from './seed.js';

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
] as const) {
  test(`Board at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await open(page, '/');
    await expect(
      page.getByRole('link', { name: new RegExp(`^Process ${BREAKER_PROCESS}, breaker open`) }),
    ).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot(`board-${width}.png`, {
      fullPage: true,
      mask: [
        page.locator('time'),
        page.getByText(/updated .* ago|updated just now/),
        page.getByLabel('Destination capacity'),
      ],
    });
  });
}
