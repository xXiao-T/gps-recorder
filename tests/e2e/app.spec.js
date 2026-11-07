import { mkdirSync, readFileSync } from 'node:fs';
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

test('定位页显示双坐标系并保存单点', async ({ page }) => {
  await page.goto('./');
  await expect(page).toHaveTitle(/点迹/);
  await expect(page.getByRole('link', { name: '定位' })).toBeVisible();

  await page.getByRole('button', { name: '获取当前位置' }).click();
  await expect(page.locator('.coord-wgs84 .coord-value')).toHaveText(
    '39.909000, 116.397000',
  );
  await expect(page.locator('.coord-gcj02 .coord-value')).toHaveText(
    '39.910403, 116.403244',
  );

  await page.screenshot({
    path: path.join(ARTIFACTS, '01-locate.png'),
    fullPage: true,
  });

  await page.getByRole('button', { name: '保存此点' }).click();
  const sheet = page.locator('dialog.sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('名称').fill('测试单点');
  await sheet.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('#toast')).toContainText('已保存单点');

  await page.getByRole('link', { name: '记录' }).click();
  await expect(page.getByRole('button', { name: /测试单点/ })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出单点' }).click();
  const exportSheet = page.locator('dialog.sheet');
  await expect(exportSheet).toBeVisible();
  await exportSheet.getByRole('button', { name: '下载', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^gps-waypoint-测试单点-.*-wgs84\.gpx$/,
  );
  const gpx = readFileSync(await download.path(), 'utf8');
  expect(gpx).toContain('<wpt');
  expect(gpx).toContain('<name>测试单点</name>');
});

test('间隔记录轨迹、暂停分段并导出 GPX', async ({ page, context }) => {
  await page.goto('./#/record');
  await expect(page.locator('.pill')).toContainText('未开始');

  await page.getByRole('button', { name: '开始记录' }).click();
  const startSheet = page.locator('dialog.sheet');
  await startSheet.getByLabel('时间间隔（秒）').fill('0');
  await startSheet.getByLabel('最小移动距离（米）').fill('0');
  await startSheet.getByLabel('精度阈值（米）').fill('0');
  await startSheet.getByRole('button', { name: '开始记录' }).click();

  await expect(page.locator('.pill')).toContainText(/记录中|等待定位/);

  await context.setGeolocation({
    latitude: 39.9092,
    longitude: 116.3972,
    accuracy: 8,
  });
  await page.waitForTimeout(1200);
  await context.setGeolocation({
    latitude: 39.9098,
    longitude: 116.3978,
    accuracy: 8,
  });
  await page.waitForTimeout(1200);

  await expect(page.locator('.pill')).toContainText('记录中');
  const pointsStat = page.locator('.stat').filter({ hasText: '点数' });
  await expect(pointsStat.locator('.stat-value')).not.toHaveText('0');

  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.locator('.pill')).toContainText('已暂停');

  await page.getByRole('button', { name: '继续记录' }).click();
  await expect(page.locator('.pill')).toContainText(/等待定位|记录中/);
  await context.setGeolocation({
    latitude: 39.9105,
    longitude: 116.3985,
    accuracy: 8,
  });
  await page.waitForTimeout(1200);
  await expect(page.locator('.pill')).toContainText('记录中');

  await page.screenshot({
    path: path.join(ARTIFACTS, '02-record.png'),
    fullPage: true,
  });

  await page.getByRole('button', { name: '结束', exact: true }).click();
  const confirm = page.locator('dialog.sheet');
  await confirm.getByRole('button', { name: '结束并保存' }).click();

  const summary = page.locator('dialog.sheet');
  await expect(summary).toBeVisible();
  await summary.getByLabel('名称').fill('测试轨迹');
  await summary.getByRole('button', { name: '保存并查看' }).click();
  await expect(page).toHaveURL(/#\/saved\/track\//);

  await expect(page.locator('.detail-title')).toHaveText('测试轨迹');
  await page.screenshot({
    path: path.join(ARTIFACTS, '03-track-detail.png'),
    fullPage: true,
  });

  await page.getByRole('button', { name: /导出/ }).first().click();
  const exportSheet = page.locator('dialog.sheet');
  await expect(exportSheet).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await exportSheet.getByRole('button', { name: '下载', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^gps-track-测试轨迹-.*-wgs84\.gpx$/,
  );
  const filePath = await download.path();
  const gpx = readFileSync(filePath, 'utf8');
  expect(gpx).toContain('<trk>');
  expect((gpx.match(/<trkseg>/g) || []).length).toBeGreaterThanOrEqual(2);
  expect((gpx.match(/<trkpt/g) || []).length).toBeGreaterThanOrEqual(2);
  expect(gpx).toContain('<name>测试轨迹</name>');
});

test('刷新后记录仍保留', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '获取当前位置' }).click();
  await expect(page.locator('.coord-wgs84 .coord-value')).toBeVisible();
  await page.getByRole('button', { name: '保存此点' }).click();
  const sheet = page.locator('dialog.sheet');
  await sheet.getByLabel('名称').fill('刷新测试点');
  await sheet.getByRole('button', { name: '保存' }).click();

  await page.reload();
  await page.getByRole('link', { name: '记录' }).click();
  await expect(page.getByRole('button', { name: /刷新测试点/ })).toBeVisible();
});

test('记录中刷新后出现草稿并可继续', async ({ page, context }) => {
  await page.goto('./#/record');
  await page.getByRole('button', { name: '开始记录' }).click();
  const startSheet = page.locator('dialog.sheet');
  await startSheet.getByLabel('时间间隔（秒）').fill('0');
  await startSheet.getByLabel('最小移动距离（米）').fill('0');
  await startSheet.getByLabel('精度阈值（米）').fill('0');
  await startSheet.getByRole('button', { name: '开始记录' }).click();

  await expect(page.locator('.pill')).toContainText(/记录中|等待定位/);
  await page.waitForTimeout(1000);
  await expect(page.locator('.pill')).toContainText('记录中');

  await page.reload();
  await expect(page.locator('.draft-card')).toBeVisible();
  await expect(page.locator('.draft-card')).toContainText('发现未完成轨迹');

  await page.locator('.draft-card').getByRole('button', { name: '继续记录' }).click();
  await expect(page.locator('.pill')).toContainText(/等待定位|记录中/);
  await expect(page.locator('.draft-card')).toHaveCount(0);

  await context.setGeolocation({
    latitude: 39.911,
    longitude: 116.399,
    accuracy: 8,
  });
  await expect(page.locator('.pill')).toContainText('记录中');
});

test('地图选点可保存', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '地图选点' }).click();
  await expect(page.getByText('准星所在位置')).toBeVisible();

  await page.getByRole('button', { name: '保存此位置' }).click();
  const sheet = page.locator('dialog.sheet');
  await sheet.getByLabel('名称').fill('地图选点测试');
  await sheet.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('#toast')).toContainText('已保存单点');

  await page.getByRole('link', { name: '记录' }).click();
  await expect(page.getByRole('button', { name: /地图选点测试/ })).toBeVisible();
});

test('设置页备份、清除与恢复', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '获取当前位置' }).click();
  await expect(page.locator('.coord-wgs84 .coord-value')).toBeVisible();
  await page.getByRole('button', { name: '保存此点' }).click();
  let sheet = page.locator('dialog.sheet');
  await sheet.getByLabel('名称').fill('备份恢复点');
  await sheet.getByRole('button', { name: '保存' }).click();

  await page.goto('./#/settings');
  await expect(page.getByText('轨迹采样')).toBeVisible();
  await page.screenshot({
    path: path.join(ARTIFACTS, '04-settings.png'),
    fullPage: true,
  });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出 JSON 备份/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^dianji-backup-\d{8}-\d{6}\.json$/);
  const backupText = readFileSync(await download.path(), 'utf8');
  const backup = JSON.parse(backupText);
  expect(backup.app).toBe('gps-recorder');
  expect(backup.schemaVersion).toBe(1);
  expect(backup.waypoints.length).toBe(1);

  await page.getByRole('button', { name: /清除全部数据/ }).click();
  sheet = page.locator('dialog.sheet');
  await sheet.getByRole('button', { name: '清除全部数据' }).click();
  await expect(page.locator('#toast')).toContainText('本机数据已清除');

  await page.goto('./#/saved');
  await expect(page.getByText('还没有单点')).toBeVisible();

  await page.goto('./#/settings');
  await page.getByRole('button', { name: '从备份恢复' }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backupText, 'utf8'),
  });
  sheet = page.locator('dialog.sheet');
  await expect(sheet).toContainText('备份包含 1 个单点');
  await Promise.all([
    page.waitForEvent('load', { timeout: 15_000 }),
    sheet.getByRole('button', { name: '覆盖并恢复' }).click(),
  ]);

  await page.goto('./#/saved');
  await expect(page.getByRole('button', { name: /备份恢复点/ })).toBeVisible();
});
