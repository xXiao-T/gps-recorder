import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'allow' });

test.beforeEach(async ({ page }) => {
  await page.route(/autonavi\.com/, (route) => route.abort());
});

test('Service Worker 缓存应用外壳，离线仍可打开', async ({ page, context }) => {
  await page.goto('./');
  await expect(page.locator('.brand-name')).toHaveText('点迹');

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, {
          once: true,
        });
      });
    }
  });
  await page.waitForTimeout(500);

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.locator('.brand-name')).toHaveText('点迹');
  await expect(page.getByRole('link', { name: '定位' })).toBeVisible();
  await expect(page.locator('#banner-offline')).toBeVisible();
  await expect(page.locator('.map-card')).toBeVisible();

  await context.setOffline(false);
});
