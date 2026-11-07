import assert from 'node:assert/strict';
import test from 'node:test';

import { validateBackup } from '../../js/backup.js';
import { haversineM } from '../../js/geo.js';

const T0 = Date.UTC(2026, 10, 7, 6, 0, 0);
const T1 = T0 + 5000;

function makeBackup(overrides = {}) {
  return {
    app: 'gps-recorder',
    schemaVersion: 1,
    exportedAt: '2026-11-07T06:00:00.000Z',
    preferences: {
      exportCrs: 'gcj02',
      sampleDefaults: { minIntervalSec: 10, minDistanceM: 5, maxAccuracyM: 20 },
      keepAwake: false,
      autoFollow: false,
      basemap: 'satellite',
    },
    waypoints: [
      {
        id: 'w1',
        name: '停车场',
        note: '测试',
        lat: 39.909,
        lng: 116.397,
        altitudeM: null,
        accuracyM: 8,
        speedMps: null,
        headingDeg: null,
        fixAt: T0,
        createdAt: T0,
        source: 'gps',
      },
    ],
    tracks: [
      {
        id: 't1',
        name: '轨迹',
        note: '',
        status: 'completed',
        createdAt: T0,
        startedAt: T0,
        endedAt: T1,
        updatedAt: T1,
        activeMs: 5000,
        segmentStartedAt: null,
        currentSegment: 1,
        stats: { pointCount: 999, distanceM: 999999 },
        sample: { minIntervalSec: 5, minDistanceM: 3, maxAccuracyM: 30 },
      },
    ],
    trackPoints: [
      {
        id: 'ignored',
        trackId: 't1',
        seq: 0,
        segment: 0,
        lat: 39.909,
        lng: 116.397,
        altitudeM: null,
        accuracyM: 8,
        speedMps: 1,
        headingDeg: 0,
        timestamp: T0,
        receivedAt: T0,
      },
      {
        trackId: 't1',
        seq: 1,
        segment: 0,
        lat: 39.9095,
        lng: 116.3975,
        timestamp: T1,
      },
      {
        trackId: 't1',
        seq: 2,
        segment: 1,
        lat: 39.91,
        lng: 116.398,
        timestamp: T1 + 5000,
      },
    ],
    ...overrides,
  };
}

test('合法备份被规范化', () => {
  const result = validateBackup(makeBackup());
  assert.equal(result.preferences.exportCrs, 'gcj02');
  assert.equal(result.waypoints.length, 1);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.trackPoints.length, 3);

  const track = result.tracks[0];
  assert.equal(track.stats.pointCount, 3);
  const expected =
    haversineM(
      { lat: 39.909, lng: 116.397 },
      { lat: 39.9095, lng: 116.3975 },
    ) + 0; // segment 1 只有单点，不累加
  assert.ok(Math.abs(track.stats.distanceM - expected) < 0.01);
  assert.equal(track.currentSegment, 1);
  assert.equal(result.trackPoints[0].id, 't1:0');
});

test('采样与偏好范围被限制', () => {
  const backup = makeBackup({
    preferences: {
      exportCrs: 'wgs84',
      sampleDefaults: { minIntervalSec: 9999, minDistanceM: 99999, maxAccuracyM: -1 },
    },
  });
  const result = validateBackup(backup);
  assert.equal(result.preferences.sampleDefaults.minIntervalSec, 600);
  assert.equal(result.preferences.sampleDefaults.minDistanceM, 5000);
  assert.equal(result.preferences.sampleDefaults.maxAccuracyM, 0);
});

test('拒绝重复 id、无效坐标与缺失引用', () => {
  const duplicateWaypoint = makeBackup();
  duplicateWaypoint.waypoints.push({ ...duplicateWaypoint.waypoints[0] });
  assert.throws(() => validateBackup(duplicateWaypoint), /id 重复/);

  const badCoord = makeBackup();
  badCoord.waypoints[0].lat = 100;
  assert.throws(() => validateBackup(badCoord), /坐标无效/);

  const orphan = makeBackup();
  orphan.trackPoints[0].trackId = 'missing';
  assert.throws(() => validateBackup(orphan), /不存在的轨迹/);

  const duplicateSeq = makeBackup();
  duplicateSeq.trackPoints[1].seq = 0;
  assert.throws(() => validateBackup(duplicateSeq), /序号重复/);
});

test('拒绝错误版本与缺少数组', () => {
  assert.throws(
    () => validateBackup(makeBackup({ schemaVersion: 2 })),
    /更高/,
  );
  assert.throws(
    () => validateBackup(makeBackup({ app: 'other' })),
    /不是点迹/,
  );
  assert.throws(
    () => validateBackup(makeBackup({ waypoints: null })),
    /waypoints/,
  );
});

test('恢复统计以实际轨迹点为准', () => {
  const backup = makeBackup();
  backup.trackPoints = backup.trackPoints.slice(0, 1);
  const result = validateBackup(backup);
  assert.equal(result.tracks[0].stats.pointCount, 1);
  assert.equal(result.tracks[0].stats.distanceM, 0);
  assert.equal(result.trackPoints.length, 1);
});
