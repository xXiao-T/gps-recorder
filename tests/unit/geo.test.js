import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatDecimal,
  formatDmsPair,
  formatLatLng,
  gcj02ToWgs84,
  haversineM,
  isOutOfChina,
  isValidLatLng,
  toDms,
  wgs84ToGcj02,
} from '../../js/geo.js';

test('WGS-84 → GCJ-02 北京固定向量', () => {
  const gcj = wgs84ToGcj02({ lat: 39.909, lng: 116.397 });
  assert.ok(Math.abs(gcj.lat - 39.910403397) < 1e-8, `lat=${gcj.lat}`);
  assert.ok(Math.abs(gcj.lng - 116.403243506) < 1e-8, `lng=${gcj.lng}`);
});

test('GCJ-02 → WGS-84 往返误差小于 1 厘米', () => {
  const points = [
    { lat: 39.909, lng: 116.397 },
    { lat: 31.2304, lng: 121.4737 },
    { lat: 22.5431, lng: 114.0579 },
  ];
  for (const wgs of points) {
    const gcj = wgs84ToGcj02(wgs);
    const back = gcj02ToWgs84(gcj);
    const errorM = haversineM(wgs, back);
    assert.ok(errorM < 0.01, `往返误差 ${errorM} m @ ${JSON.stringify(wgs)}`);
  }
});

test('境外坐标不做偏移', () => {
  const tokyo = { lat: 35.681236, lng: 139.767125 };
  const nyc = { lat: 40.7128, lng: -74.006 };
  for (const p of [tokyo, nyc]) {
    assert.deepEqual(wgs84ToGcj02(p), p);
    assert.deepEqual(gcj02ToWgs84(p), p);
  }
  assert.equal(isOutOfChina(35.681236, 139.767125), true);
  assert.equal(isOutOfChina(39.909, 116.397), false);
});

test('坐标合法性校验', () => {
  assert.equal(isValidLatLng(0, 0), true);
  assert.equal(isValidLatLng(-90, 180), true);
  assert.equal(isValidLatLng(90.0001, 0), false);
  assert.equal(isValidLatLng(0, 180.1), false);
  assert.equal(isValidLatLng(NaN, 0), false);
  assert.equal(isValidLatLng(Infinity, 0), false);
});

test('十进制度格式化与 -0 归一', () => {
  assert.equal(formatDecimal(39.909, 6), '39.909000');
  assert.equal(formatDecimal(-116.3971234, 6), '-116.397123');
  assert.equal(formatDecimal(-0.0000001, 6), '0.000000');
  assert.equal(formatDecimal(-0, 6), '0.000000');
  assert.equal(formatDecimal(NaN), '—');
});

test('DMS 格式与半球', () => {
  assert.equal(toDms(39.909, 'lat'), '39°54′32.40″N');
  assert.equal(toDms(-116.397, 'lng'), '116°23′49.20″W');
  assert.equal(toDms(0, 'lat'), '0°00′00.00″N');
  assert.equal(toDms(-33.8688, 'lat'), '33°52′07.68″S');
  assert.equal(formatDmsPair({ lat: 39.909, lng: 116.397 }), '39°54′32.40″N, 116°23′49.20″E');
});

test('DMS 秒/分进位', () => {
  assert.equal(toDms(12.999999999, 'lat'), '13°00′00.00″N');
  assert.equal(toDms(12.999999, 'lat'), '13°00′00.00″N');
  assert.equal(toDms(12.9999, 'lat'), '12°59′59.64″N');
});

test('经纬度成对格式化', () => {
  assert.equal(formatLatLng({ lat: 39.909, lng: 116.397 }), '39.909000, 116.397000');
});

test('haversine 距离', () => {
  const p = { lat: 39.909, lng: 116.397 };
  assert.equal(haversineM(p, p), 0);
  const oneDegree = haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  assert.ok(Math.abs(oneDegree - 111_194.93) < 2, `1° 距离 ${oneDegree}`);
  const beijingToShanghai = haversineM(
    { lat: 39.909, lng: 116.397 },
    { lat: 31.2304, lng: 121.4737 },
  );
  assert.ok(beijingToShanghai > 1_050_000 && beijingToShanghai < 1_100_000);
});
