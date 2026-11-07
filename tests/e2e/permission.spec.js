import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const ARTIFACTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'artifacts',
);

test.beforeAll(() => {
  mkdirSync(ARTIFACTS, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.route(/autonavi\.com/, (route) => route.abort());
});

test('权限被拒绝时给出开启说明，不触发定位请求', async ({ page }) => {
  await page.addInitScript(() => {
    const status = { state: 'denied', onchange: null };
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: async () => status },
    });
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: () => {
          window.__geoCalled = (window.__geoCalled || 0) + 1;
        },
        watchPosition: () => 1,
        clearWatch: () => {},
      },
    });
  });

  await page.goto('./');
  const permissionCard = page.locator('.permission-card');
  await expect(permissionCard).toContainText('已拒绝');
  await expect(permissionCard.getByRole('button', { name: '开启方法' })).toBeVisible();

  await page.getByRole('button', { name: '获取当前位置' }).click();
  const sheet = page.locator('dialog.sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('开启定位权限');
  await expect(sheet).toContainText('Chrome 打开本页');
  expect(await page.evaluate(() => window.__geoCalled || 0)).toBe(0);
  await page.screenshot({
    path: path.join(ARTIFACTS, 'permission-help.png'),
    fullPage: true,
  });
});

test('未授权时先显示说明，再触发浏览器授权并成功定位', async ({ page }) => {
  await page.addInitScript(() => {
    const status = { state: 'prompt', onchange: null };
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: async () => status },
    });
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: () => {},
        watchPosition: (success) => {
          window.__geoCalled = (window.__geoCalled || 0) + 1;
          setTimeout(() => {
            success({
              coords: {
                latitude: 39.9087,
                longitude: 116.3975,
                accuracy: 5,
                altitude: null,
                altitudeAccuracy: null,
                heading: null,
                speed: null,
              },
              timestamp: Date.now(),
            });
          }, 20);
          return 1;
        },
        clearWatch: () => {},
      },
    });
  });

  await page.goto('./');
  const permissionCard = page.locator('.permission-card');
  await expect(permissionCard).toContainText('未授权');
  await page.screenshot({
    path: path.join(ARTIFACTS, 'permission-prompt.png'),
    fullPage: true,
  });

  await page.getByRole('button', { name: '获取当前位置' }).click();
  const primer = page.locator('dialog.sheet');
  await expect(primer).toContainText('允许获取位置');
  await page.screenshot({
    path: path.join(ARTIFACTS, 'permission-primer.png'),
    fullPage: true,
  });
  await primer.getByRole('button', { name: '继续，允许定位' }).click();

  await expect(page.locator('.coord-wgs84 .coord-value')).toHaveText(
    '39.908700, 116.397500',
  );
  await expect(permissionCard).toContainText('已允许');
  expect(await page.evaluate(() => window.__geoCalled)).toBe(1);
});

test('权限询问未处理时可取消，并有超时兜底', async ({ page }) => {
  await page.addInitScript(() => {
    const status = { state: 'granted', onchange: null };
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: async () => status },
    });
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        // 回调永远不触发，模拟系统权限弹窗一直未被处理
        getCurrentPosition: () => {},
        watchPosition: (success, error, options) => {
          window.__geoCalled = (window.__geoCalled || 0) + 1;
          window.__watchOptions = window.__watchOptions || [];
          window.__watchOptions.push(Boolean(options?.enableHighAccuracy));
          return window.__geoCalled;
        },
        clearWatch: () => {
          window.__cleared = (window.__cleared || 0) + 1;
        },
      },
    });
  });

  await page.goto('./');
  const locateButton = page.getByRole('button', { name: /获取当前位置|重新获取位置/ });
  await locateButton.click();
  await expect(page.getByRole('button', { name: '取消等待' })).toBeVisible();
  await expect(page.locator('.status-box')).toContainText('正在获取定位');

  await page.getByRole('button', { name: '取消等待' }).click();
  await expect(page.getByRole('button', { name: '获取当前位置' })).toBeVisible();
  await expect(page.locator('.status-box')).toContainText('已取消等待');
  expect(await page.evaluate(() => window.__cleared || 0)).toBeGreaterThanOrEqual(1);

  // 第二次请求，用 Playwright clock 快进 21 秒验证 JS 超时兜底
  await expect(page.locator('.permission-card')).toContainText('已允许');
  await page.clock.install();
  await page.getByRole('button', { name: '获取当前位置' }).click();
  await expect(page.getByRole('button', { name: '取消等待' })).toBeVisible();

  // 先快进 9 秒，确认高精度阶段结束后切换到低精度
  await page.clock.fastForward(9_000);
  await expect(page.locator('.status-box')).toContainText('低精度定位');
  let watchOptions = await page.evaluate(() => window.__watchOptions || []);
  expect(watchOptions).toContain(false);

  // 再快进到 21 秒，触发整体超时
  await page.clock.fastForward(12_000);
  await expect(page.locator('.status-box')).toContainText('等待定位超时');
  await expect(page.getByRole('button', { name: '获取当前位置' })).toBeVisible();
  expect(await page.evaluate(() => window.__geoCalled)).toBeGreaterThanOrEqual(3);
  watchOptions = await page.evaluate(() => window.__watchOptions || []);
  expect(watchOptions).toContain(false);
  expect(await page.evaluate(() => window.__cleared || 0)).toBeGreaterThanOrEqual(2);
  await page.screenshot({
    path: path.join(ARTIFACTS, 'permission-timeout.png'),
    fullPage: true,
  });
});

test('记录等待首个 GPS 信号超时后给出诊断与重试入口', async ({ page }) => {
  await page.addInitScript(() => {
    const status = { state: 'granted', onchange: null };
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: async () => status },
    });
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: () => {},
        watchPosition: () => 1,
        clearWatch: () => {},
      },
    });
  });

  await page.goto('./#/record');
  await page.clock.install();
  await page.getByRole('button', { name: '开始记录' }).click();
  const startSheet = page.locator('dialog.sheet');
  await startSheet.getByLabel('时间间隔（秒）').fill('0');
  await startSheet.getByLabel('最小移动距离（米）').fill('0');
  await startSheet.getByLabel('精度阈值（米）').fill('0');
  await startSheet.getByRole('button', { name: '开始记录' }).click();

  await expect(page.locator('.pill')).toContainText('等待定位');
  await page.clock.fastForward(21_000);
  await expect(page.locator('.alert-card')).toContainText('20 秒未收到 GPS 信号');
  await expect(page.getByRole('button', { name: '重试定位' })).toBeVisible();
  await expect(page.getByRole('button', { name: '开启定位权限' })).toBeVisible();
  await page.screenshot({
    path: path.join(ARTIFACTS, 'record-no-fix.png'),
    fullPage: true,
  });
});
