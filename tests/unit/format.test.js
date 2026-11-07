import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultTrackName,
  describeSample,
  formatAccuracy,
  formatAverageSpeed,
  formatBytes,
  formatDistance,
  formatDuration,
  formatSpeed,
} from '../../js/format.js';

test('时长格式化', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(65_000), '01:05');
  assert.equal(formatDuration(3_723_000), '1:02:03');
  assert.equal(formatDuration(-5), '00:00');
});

test('距离格式化', () => {
  assert.equal(formatDistance(0), '0.0 m');
  assert.equal(formatDistance(5.24), '5.2 m');
  assert.equal(formatDistance(123.6), '124 m');
  assert.equal(formatDistance(1240), '1.24 km');
  assert.equal(formatDistance(Number.NaN), '—');
});

test('速度、精度与平均速度', () => {
  assert.equal(formatSpeed(1), '3.6 km/h');
  assert.equal(formatSpeed(10), '36 km/h');
  assert.equal(formatSpeed(null), '—');
  assert.equal(formatAccuracy(8.4), '±8 m');
  assert.equal(formatAverageSpeed(1000, 600_000), '6.0 km/h');
  assert.equal(formatAverageSpeed(1000, 0), '—');
});

test('采样规则描述', () => {
  assert.equal(
    describeSample({ minIntervalSec: 5, minDistanceM: 3, maxAccuracyM: 30 }),
    '每 5 秒且移动 ≥ 3 米 · 精度 ≤ 30 米',
  );
  assert.equal(
    describeSample({ minIntervalSec: 0, minDistanceM: 10, maxAccuracyM: 0 }),
    '移动 ≥ 10 米',
  );
  assert.equal(
    describeSample({ minIntervalSec: 0, minDistanceM: 0, maxAccuracyM: 0 }),
    '每个通过精度检查的定位点',
  );
  assert.equal(
    describeSample({
      minIntervalSec: 5,
      minDistanceM: 3,
      maxAccuracyM: 0,
      lowAccuracy: true,
    }),
    '每 5 秒且移动 ≥ 3 米 · 低精度模式',
  );
});

test('默认名称与字节格式化', () => {
  const ms = new Date(2026, 10, 7, 14, 32).getTime();
  assert.equal(defaultTrackName(ms), '轨迹 11-07 14:32');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(15 * 1024 * 1024), '15 MB');
});
