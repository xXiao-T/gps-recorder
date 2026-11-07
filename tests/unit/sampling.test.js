import assert from 'node:assert/strict';
import test from 'node:test';

import { haversineM } from '../../js/geo.js';
import {
  activeDurationMs,
  averageSpeedMps,
  detectGap,
  evaluateSample,
  normalizeSample,
} from '../../js/sampling.js';

const sample = { minIntervalSec: 5, minDistanceM: 3, maxAccuracyM: 30 };

function fix(overrides = {}) {
  return {
    lat: 39.909,
    lng: 116.397,
    accuracyM: 10,
    timestamp: 1_000_000,
    ...overrides,
  };
}

test('normalizeSample 补全与容错', () => {
  assert.deepEqual(normalizeSample({ minIntervalSec: 0 }), {
    minIntervalSec: 0,
    minDistanceM: 3,
    maxAccuracyM: 30,
    lowAccuracy: false,
  });
  assert.deepEqual(normalizeSample({ minIntervalSec: -1, minDistanceM: 'x' }), {
    minIntervalSec: 5,
    minDistanceM: 3,
    maxAccuracyM: 30,
    lowAccuracy: false,
  });
  assert.equal(normalizeSample({ lowAccuracy: true }).lowAccuracy, true);
});

test('首个点通过精度后直接接受', () => {
  const result = evaluateSample({
    fix: fix(),
    lastAccepted: null,
    isNewSegment: false,
    sample,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'segment-start');
});

test('精度阈值拒绝，0 表示关闭', () => {
  const rejected = evaluateSample({
    fix: fix({ accuracyM: 50 }),
    lastAccepted: null,
    isNewSegment: false,
    sample,
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'accuracy-exceeded');

  const missing = evaluateSample({
    fix: fix({ accuracyM: null }),
    lastAccepted: null,
    isNewSegment: false,
    sample,
  });
  assert.equal(missing.accepted, false);
  assert.equal(missing.reason, 'accuracy-missing');

  const disabled = evaluateSample({
    fix: fix({ accuracyM: null }),
    lastAccepted: null,
    isNewSegment: false,
    sample: { ...sample, maxAccuracyM: 0 },
  });
  assert.equal(disabled.accepted, true);
});

test('时间与距离条件为 AND 关系', () => {
  const last = fix({ timestamp: 1_000_000 });
  const near = fix({
    lat: 39.90901,
    timestamp: 1_006_000,
  });
  // 约 1.1 米，时间满足但距离不足
  const nearResult = evaluateSample({
    fix: near,
    lastAccepted: last,
    isNewSegment: false,
    sample,
  });
  assert.equal(nearResult.accepted, false);
  assert.equal(nearResult.reason, 'too-close');

  const soon = fix({
    lat: 39.9105,
    timestamp: 1_003_000,
  });
  // 距离满足但时间不足
  const soonResult = evaluateSample({
    fix: soon,
    lastAccepted: last,
    isNewSegment: false,
    sample,
  });
  assert.equal(soonResult.accepted, false);
  assert.equal(soonResult.reason, 'too-soon');

  const ok = fix({
    lat: 39.9105,
    timestamp: 1_006_000,
  });
  const okResult = evaluateSample({
    fix: ok,
    lastAccepted: last,
    isNewSegment: false,
    sample,
  });
  assert.equal(okResult.accepted, true);
  assert.ok(okResult.distanceM > 100, 'distance should be computed');
});

test('0 可关闭时间或距离条件', () => {
  const last = fix({ timestamp: 1_000_000 });
  const result = evaluateSample({
    fix: fix({ timestamp: 1_001_000 }),
    lastAccepted: last,
    isNewSegment: false,
    sample: { minIntervalSec: 0, minDistanceM: 0, maxAccuracyM: 30 },
  });
  assert.equal(result.accepted, true);
});

test('新段首点忽略时间与距离，但检查精度', () => {
  const last = fix({ timestamp: 1_000_000 });
  const result = evaluateSample({
    fix: fix({ lat: 39.909001, timestamp: 1_000_001 }),
    lastAccepted: last,
    isNewSegment: true,
    sample,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'segment-start');

  const bad = evaluateSample({
    fix: fix({ accuracyM: 99, timestamp: 1_000_001 }),
    lastAccepted: last,
    isNewSegment: true,
    sample,
  });
  assert.equal(bad.accepted, false);
});

test('时间戳倒退或重复被拒绝', () => {
  const last = fix({ timestamp: 1_000_000 });
  for (const timestamp of [999_999, 1_000_000]) {
    const result = evaluateSample({
      fix: fix({ timestamp, lat: 39.92 }),
      lastAccepted: last,
      isNewSegment: false,
      sample,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'stale-timestamp');
  }
});

test('坐标非法被拒绝', () => {
  const result = evaluateSample({
    fix: fix({ lat: 100 }),
    lastAccepted: null,
    isNewSegment: false,
    sample,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'invalid');
});

test('GPS 中断检测', () => {
  assert.equal(detectGap(0, 30_000, 5), false);
  assert.equal(detectGap(0, 30_001, 5), true);
  assert.equal(detectGap(0, 60_001, 20), true); // 3 × 20s = 60s 阈值
  assert.equal(detectGap(0, 59_000, 20), false);
  assert.equal(detectGap(null, 100_000, 5), false);
});

test('平均速度与活跃时长', () => {
  assert.equal(averageSpeedMps(1000, 0), null);
  assert.equal(averageSpeedMps(1000, 100_000), 10);

  assert.equal(activeDurationMs({ activeMs: 5000, segmentStartedAt: null }, 10_000), 5000);
  assert.equal(activeDurationMs({ activeMs: 5000, segmentStartedAt: 9000 }, 15_000), 11_000);
});

test('距离与采样组合的边界', () => {
  const last = { lat: 0, lng: 0, timestamp: 0 };
  const exactlyOneDegree = { lat: 0, lng: 1, timestamp: 5000, accuracyM: 1 };
  const result = evaluateSample({
    fix: exactlyOneDegree,
    lastAccepted: last,
    isNewSegment: false,
    sample: { minIntervalSec: 5, minDistanceM: 3, maxAccuracyM: 30 },
  });
  assert.equal(result.accepted, true);
  assert.ok(Math.abs(result.distanceM - haversineM(last, exactlyOneDegree)) < 1e-9);
});
