import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExportFilename,
  buildTrackFile,
  buildWaypointFile,
  csvEscape,
  escapeXml,
  groupTrackPoints,
  safeFilenamePart,
  serializeTrack,
  serializeWaypoint,
} from '../../js/formats.js';

const T0 = Date.UTC(2026, 10, 7, 6, 0, 0);
const T1 = Date.UTC(2026, 10, 7, 6, 0, 5);
const T2 = Date.UTC(2026, 10, 7, 6, 1, 0);

function makeWaypoint(overrides = {}) {
  return {
    id: 'w1',
    name: '测试 <点> & "引号"',
    note: '备注, 含逗号\n第二行',
    lat: 39.909,
    lng: 116.397,
    altitudeM: null,
    accuracyM: 10.2,
    speedMps: null,
    headingDeg: null,
    fixAt: T0,
    createdAt: T0,
    source: 'gps',
    ...overrides,
  };
}

function makeTrack(overrides = {}) {
  return {
    id: 't1',
    name: '轨迹 A',
    note: '',
    status: 'completed',
    createdAt: T0,
    startedAt: T0,
    endedAt: T2,
    stats: { pointCount: 3, distanceM: 123.4 },
    sample: { minIntervalSec: 5, minDistanceM: 3, maxAccuracyM: 30 },
    ...overrides,
  };
}

function makeFourPoints() {
  const points = makePoints();
  return [
    points[0],
    points[1],
    { ...points[2], seq: 2, segment: 1, lat: 39.91, lng: 116.398 },
    {
      ...points[2],
      id: 't1:3',
      seq: 3,
      segment: 1,
      lat: 39.9105,
      lng: 116.3985,
      timestamp: T2 + 5000,
    },
  ];
}

function makePoints() {
  return [
    {
      id: 't1:0',
      trackId: 't1',
      seq: 0,
      segment: 0,
      lat: 39.909,
      lng: 116.397,
      altitudeM: null,
      accuracyM: 8,
      speedMps: 1.2,
      headingDeg: 10,
      timestamp: T0,
    },
    {
      id: 't1:1',
      trackId: 't1',
      seq: 1,
      segment: 0,
      lat: 39.9095,
      lng: 116.3975,
      altitudeM: null,
      accuracyM: 8,
      speedMps: 1.3,
      headingDeg: 11,
      timestamp: T1,
    },
    {
      id: 't1:2',
      trackId: 't1',
      seq: 2,
      segment: 1,
      lat: 39.91,
      lng: 116.398,
      altitudeM: null,
      accuracyM: 8,
      speedMps: 1.4,
      headingDeg: 12,
      timestamp: T2,
    },
  ];
}

test('XML 转义与非法字符剔除', () => {
  assert.equal(
    escapeXml('a & b < c > d "e" \'f\''),
    'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;',
  );
  assert.equal(escapeXml(`a${String.fromCharCode(0)}b${String.fromCharCode(11)}c`), 'abc');
  assert.equal(escapeXml(null), '');
});

test('单点 GPX 结构、时间与可选海拔', () => {
  const gpx = serializeWaypoint(makeWaypoint(), { format: 'gpx' });
  assert.match(gpx, /<gpx version="1.1"/);
  assert.match(gpx, /<wpt lat="39\.9090000" lon="116\.3970000">/);
  assert.match(gpx, /<time>2026-11-07T06:00:00\.000Z<\/time>/);
  assert.match(gpx, /测试 &lt;点&gt; &amp; &quot;引号&quot;/);
  assert.match(gpx, /<gpsrec:accuracyM>10\.20<\/gpsrec:accuracyM>/);
  assert.doesNotMatch(gpx, /<ele>/);

  const withAlt = serializeWaypoint(makeWaypoint({ altitudeM: 120.5 }), { format: 'gpx' });
  assert.match(withAlt, /<ele>120\.5<\/ele>/);
});

test('单点 KML 点与海拔模式', () => {
  const kml = serializeWaypoint(makeWaypoint({ altitudeM: 120.5 }), { format: 'kml' });
  assert.match(kml, /<altitudeMode>absolute<\/altitudeMode>/);
  assert.match(kml, /<coordinates>116\.3970000,39\.9090000,120\.5<\/coordinates>/);
  assert.match(kml, /<Data name="coordinateSystem"><value>WGS-84<\/value><\/Data>/);

  const flat = serializeWaypoint(makeWaypoint(), { format: 'kml' });
  assert.doesNotMatch(flat, /<altitudeMode>/);
  assert.match(flat, /<coordinates>116\.3970000,39\.9090000<\/coordinates>/);
});

test('单点 GeoJSON 坐标顺序与属性', () => {
  const text = serializeWaypoint(makeWaypoint(), { format: 'geojson' });
  const feature = JSON.parse(text);
  assert.equal(feature.type, 'Feature');
  assert.equal(feature.geometry.type, 'Point');
  assert.deepEqual(feature.geometry.coordinates, [116.397, 39.909]);
  assert.equal(feature.properties.name, '测试 <点> & "引号"');
  assert.equal(feature.properties.coordinateSystem, 'WGS-84');
  assert.equal(feature.properties.time, '2026-11-07T06:00:00.000Z');
});

test('单点 CSV 含 BOM、CRLF 与 RFC 4180 引号', () => {
  const csv = serializeWaypoint(makeWaypoint(), { format: 'csv' });
  assert.ok(csv.startsWith('﻿type,name,note,lat,lon'));
  assert.ok(csv.includes('\r\n'));
  assert.ok(csv.includes('"备注, 含逗号\n第二行"'));
  assert.ok(csv.includes('"测试 <点> & ""引号"""'));
});

test('CSV 公式注入防护', () => {
  const wp = makeWaypoint({ name: '=HYPERLINK("x")', note: '-cmd' });
  const csv = serializeWaypoint(wp, { format: 'csv' });
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes(",'-cmd,"));
  assert.equal(csvEscape('=1+1'), "'=1+1");
  assert.equal(csvEscape('-1', { formulaGuard: false }), '-1');
});

test('单点纯文本导出', () => {
  const text = serializeWaypoint(makeWaypoint(), { format: 'txt' });
  assert.match(text, /坐标系：WGS-84/);
  assert.match(text, /经纬度：39\.909000, 116\.397000/);
  assert.match(text, /DMS：39°54′32\.40″N, 116°23′49\.20″E/);
  assert.match(text, /海拔：—/);
  assert.match(text, /备注：备注, 含逗号/);
});

test('导出不修改输入对象', () => {
  const wp = makeWaypoint();
  const before = structuredClone(wp);
  serializeWaypoint(wp, { format: 'geojson', crs: 'gcj02' });
  assert.deepEqual(wp, before);

  const track = makeTrack();
  const points = makePoints();
  const trackBefore = structuredClone(track);
  const pointsBefore = structuredClone(points);
  serializeTrack(track, points, { format: 'gpx', crs: 'gcj02' });
  assert.deepEqual(track, trackBefore);
  assert.deepEqual(points, pointsBefore);
});

test('GCJ-02 导出转换与坐标系标记', () => {
  const gpx = serializeWaypoint(makeWaypoint(), { format: 'gpx', crs: 'gcj02' });
  assert.match(gpx, /lat="39\.9104034" lon="116\.4032435"/);
  assert.match(gpx, /<gpsrec:coordinateSystem>GCJ-02<\/gpsrec:coordinateSystem>/);

  const kml = serializeTrack(makeTrack(), makePoints(), { format: 'kml', crs: 'gcj02' });
  assert.match(kml, /<Data name="coordinateSystem"><value>GCJ-02<\/value><\/Data>/);
});

test('轨迹按段分组', () => {
  const grouped = groupTrackPoints([...makePoints()].reverse());
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].segment, 0);
  assert.deepEqual(grouped[0].points.map((p) => p.seq), [0, 1]);
  assert.equal(grouped[1].segment, 1);
});

test('轨迹 GPX 多 trkseg、逐点时间与扩展', () => {
  const gpx = serializeTrack(makeTrack(), makePoints(), { format: 'gpx' });
  assert.equal((gpx.match(/<trkseg>/g) || []).length, 2);
  assert.equal((gpx.match(/<trkpt/g) || []).length, 3);
  assert.match(gpx, /<time>2026-11-07T06:00:00\.000Z<\/time>/);
  assert.match(gpx, /<gpsrec:speedMps>1\.20<\/gpsrec:speedMps>/);
  assert.match(gpx, /<gpsrec:distanceM>123\.40<\/gpsrec:distanceM>/);
  assert.match(gpx, /minIntervalSec="5" minDistanceM="3" maxAccuracyM="30"/);
});

test('轨迹 KML 多段 MultiGeometry 与海拔策略', () => {
  const kml = serializeTrack(makeTrack(), makeFourPoints(), { format: 'kml' });
  assert.match(kml, /<MultiGeometry>/);
  assert.equal((kml.match(/<LineString>/g) || []).length, 2);
  assert.doesNotMatch(kml, /<altitudeMode>/);

  const withAlt = makeFourPoints().map((p) => ({ ...p, altitudeM: 50.5 }));
  const kml3d = serializeTrack(makeTrack(), withAlt, { format: 'kml' });
  assert.match(kml3d, /116\.3970000,39\.9090000,50\.5/);
  assert.match(kml3d, /<altitudeMode>absolute<\/altitudeMode>/);

  const mixed = makeFourPoints();
  mixed[1].altitudeM = 51;
  const kml2d = serializeTrack(makeTrack(), mixed, { format: 'kml' });
  assert.doesNotMatch(kml2d, /<altitudeMode>/);
});

test('轨迹 KML 含单点分段时使用 Point 几何', () => {
  const kml = serializeTrack(makeTrack(), makePoints(), { format: 'kml' });
  assert.match(kml, /<MultiGeometry>/);
  assert.equal((kml.match(/<LineString>/g) || []).length, 1);
  assert.equal((kml.match(/<Point>/g) || []).length, 1);
});

test('轨迹 GeoJSON 多段、单段与单点', () => {
  const feature = JSON.parse(
    serializeTrack(makeTrack(), makeFourPoints(), { format: 'geojson' }),
  );
  assert.equal(feature.geometry.type, 'MultiLineString');
  assert.equal(feature.geometry.coordinates.length, 2);
  assert.deepEqual(feature.geometry.coordinates[0][0], [116.397, 39.909]);
  assert.equal(feature.properties.segmentCount, 2);
  assert.equal(feature.properties.distanceM, 123.4);

  const single = makeFourPoints().map((p) => ({ ...p, segment: 0 }));
  const singleFeature = JSON.parse(
    serializeTrack(makeTrack(), single, { format: 'geojson' }),
  );
  assert.equal(singleFeature.geometry.type, 'LineString');

  const onePoint = [single[0]];
  const oneFeature = JSON.parse(
    serializeTrack(makeTrack(), onePoint, { format: 'geojson' }),
  );
  assert.equal(oneFeature.geometry.type, 'Point');
});

test('轨迹 GeoJSON 含单点分段时使用 GeometryCollection', () => {
  const feature = JSON.parse(
    serializeTrack(makeTrack(), makePoints(), { format: 'geojson' }),
  );
  assert.equal(feature.geometry.type, 'GeometryCollection');
  assert.equal(feature.geometry.geometries.length, 2);
  assert.equal(feature.geometry.geometries[0].type, 'LineString');
  assert.equal(feature.geometry.geometries[1].type, 'Point');
});

test('轨迹 GeoJSON 海拔维度一致性', () => {
  const singleAlt = makeFourPoints()
    .filter((p) => p.segment === 0)
    .map((p, i) => ({ ...p, altitudeM: 10 + i }));
  const feature = JSON.parse(
    serializeTrack(makeTrack(), singleAlt, { format: 'geojson' }),
  );
  assert.equal(feature.geometry.type, 'LineString');
  assert.equal(feature.geometry.coordinates[0].length, 3);
  assert.equal(feature.geometry.coordinates[0][2], 10);

  const flatPoints = makeFourPoints().filter((p) => p.segment === 0);
  const flatFeature = JSON.parse(
    serializeTrack(makeTrack(), flatPoints, { format: 'geojson' }),
  );
  assert.equal(flatFeature.geometry.coordinates[0].length, 2);
});

test('轨迹 CSV 每点一行并包含 segment/seq', () => {
  const csv = serializeTrack(makeTrack(), makePoints(), { format: 'csv' });
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].includes('segment,seq'));
  assert.ok(lines[1].includes(',0,0,39.9090000,116.3970000,'));
  assert.ok(lines[3].includes(',1,2,'));
});

test('文本格式不支持轨迹导出', () => {
  assert.throws(() => serializeTrack(makeTrack(), makePoints(), { format: 'txt' }), /仅支持单点/);
});

test('文件名安全化与坐标系后缀', () => {
  assert.equal(safeFilenamePart('CON'), '_CON');
  assert.equal(safeFilenamePart('a/b\\c:*?"<>|'), `a_b_c${'_'.repeat(7)}`);
  assert.equal(safeFilenamePart('   '), 'item');
  assert.equal(safeFilenamePart('..'), 'item');
  assert.equal(Array.from(safeFilenamePart('中'.repeat(100))).length, 40);

  const filename = buildExportFilename(
    'track',
    '轨迹 A',
    Date.UTC(2026, 10, 7, 6, 0, 0),
    'gcj02',
    'gpx',
  );
  assert.match(filename, /^gps-track-轨迹 A-\d{8}-\d{6}-gcj02\.gpx$/);
});

test('构建完整文件对象', () => {
  const file = buildWaypointFile(makeWaypoint(), { format: 'gpx', crs: 'wgs84' });
  assert.equal(file.filename.endsWith('-wgs84.gpx'), true);
  assert.equal(file.mime, 'application/gpx+xml');
  assert.match(file.text, /<wpt/);

  const trackFile = buildTrackFile(makeTrack(), makePoints(), { format: 'csv', crs: 'gcj02' });
  assert.equal(trackFile.filename.endsWith('-gcj02.csv'), true);
  assert.ok(trackFile.text.startsWith('﻿'));
});
