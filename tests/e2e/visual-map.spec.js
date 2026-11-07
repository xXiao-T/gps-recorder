import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const ARTIFACTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'artifacts',
);

test.skip(!process.env.RUN_VISUAL, '需要外网访问高德瓦片，设置 RUN_VISUAL=1 运行');

test.beforeAll(() => {
  mkdirSync(ARTIFACTS, { recursive: true });
});

test('真实高德瓦片加载与 WGS-84 对齐（天安门）', async ({ page, context }) => {
  await context.setGeolocation({
    latitude: 39.9087,
    longitude: 116.3975,
    accuracy: 5,
  });

  await page.goto('./');
  await page.getByRole('button', { name: '获取当前位置' }).click();
  await expect(page.locator('.coord-wgs84 .coord-value')).toHaveText(
    '39.908700, 116.397500',
  );

  // 等瓦片加载完成
  await page.waitForFunction(
    () => document.querySelectorAll('.leaflet-tile-loaded').length >= 3,
    null,
    { timeout: 20_000 },
  );

  await page.screenshot({
    path: path.join(ARTIFACTS, '05-real-map-locate.png'),
    fullPage: true,
  });
  await page
    .locator('.map-card')
    .screenshot({ path: path.join(ARTIFACTS, '06-real-map.png') });

  // 缩放到 z13 便于肉眼核对地标与坐标是否对齐
  const zoomOut = page.locator('.leaflet-control-zoom-out');
  await zoomOut.click();
  await zoomOut.click();
  await zoomOut.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.leaflet-tile-loaded').length >= 3,
    null,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(800);
  await page
    .locator('.map-card')
    .screenshot({ path: path.join(ARTIFACTS, '06b-real-map-z13.png') });

  const loadedTiles = await page.locator('.leaflet-tile-loaded').count();
  expect(loadedTiles).toBeGreaterThan(2);
});
