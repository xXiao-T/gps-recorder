/**
 * 导出序列化（纯函数）：GPX / KML / GeoJSON / CSV / 纯文本。
 *
 * 设计原则：
 * - 不修改输入对象；坐标转换只发生在输出副本上。
 * - 数据库坐标始终为 WGS-84；选择 GCJ-02 仅影响本次导出。
 * - 用户文本一律转义，避免 XML/CSV 注入与文件损坏。
 */

import { APP_VERSION, CRS_SHORT, EXPORT_FORMATS } from './constants.js';
import { formatDateTimeSec, isoTime } from './format.js';
import { formatDmsPair, formatLatLng, wgs84ToGcj02 } from './geo.js';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const GPX_NS = 'http://www.topografix.com/GPX/1/1';
const GPX_XSD = 'http://www.topografix.com/GPX/1/1/gpx.xsd';
const EXT_NS = 'urn:gps-recorder:1';

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function stripXmlIllegalChars(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const valid =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);
    if (valid) out += ch;
  }
  return out;
}

/** 删除 XML 1.0 非法控制字符并做完整实体转义。 */
export function escapeXml(value) {
  return stripXmlIllegalChars(String(value ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlTag(name, value, indent = '    ') {
  if (value === null || value === undefined || value === '') return '';
  return `${indent}<${name}>${escapeXml(value)}</${name}>\n`;
}

function fixed(value, digits) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : null;
}

function pointTime(point) {
  if (Number.isFinite(point?.timestamp)) return point.timestamp;
  if (Number.isFinite(point?.fixAt)) return point.fixAt;
  if (Number.isFinite(point?.createdAt)) return point.createdAt;
  return null;
}

function resolveFormat(formatId) {
  const fmt = EXPORT_FORMATS[formatId];
  if (!fmt) throw new Error(`不支持的导出格式：${formatId}`);
  return fmt;
}

function resolveCrs(crs) {
  return crs === 'gcj02' ? 'gcj02' : 'wgs84';
}

function convertCoord(coord, crs) {
  const converted = crs === 'gcj02' ? wgs84ToGcj02(coord) : coord;
  return { lat: converted.lat, lng: converted.lng };
}

/** 按段分组（segment 升序），保持 seq 顺序。 */
export function groupTrackPoints(points) {
  const sorted = [...(points || [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const map = new Map();
  for (const point of sorted) {
    const segment = Number.isFinite(point.segment) ? point.segment : 0;
    if (!map.has(segment)) map.set(segment, []);
    map.get(segment).push(point);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([segment, items]) => ({ segment, points: items }));
}

function prepareTrackPoints(points, crs) {
  return [...(points || [])]
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((point) => {
      const converted = convertCoord(point, crs);
      return { ...point, lat: converted.lat, lng: converted.lng };
    });
}

function sampleXml(sample) {
  if (!sample) return '';
  const attrs = [
    `minIntervalSec="${escapeXml(sample.minIntervalSec ?? 0)}"`,
    `minDistanceM="${escapeXml(sample.minDistanceM ?? 0)}"`,
    `maxAccuracyM="${escapeXml(sample.maxAccuracyM ?? 0)}"`,
  ].join(' ');
  return `      <gpsrec:sampling ${attrs}/>\n`;
}

// ---------------------------------------------------------------------------
// GPX
// ---------------------------------------------------------------------------

function gpxWaypoint(wp) {
  const time = isoTime(pointTime(wp));
  const ele = fixed(wp.altitudeM, 1);
  const ext = [
    wp.accuracyM != null ? `        <gpsrec:accuracyM>${fixed(wp.accuracyM, 2)}</gpsrec:accuracyM>\n` : '',
    wp.speedMps != null ? `        <gpsrec:speedMps>${fixed(wp.speedMps, 2)}</gpsrec:speedMps>\n` : '',
    wp.headingDeg != null ? `        <gpsrec:headingDeg>${fixed(wp.headingDeg, 1)}</gpsrec:headingDeg>\n` : '',
    `        <gpsrec:coordinateSystem>${CRS_SHORT[wp.__crs]}</gpsrec:coordinateSystem>\n`,
    wp.source ? `        <gpsrec:source>${escapeXml(wp.source)}</gpsrec:source>\n` : '',
  ].join('');

  return (
    `  <wpt lat="${fixed(wp.lat, 7)}" lon="${fixed(wp.lng, 7)}">\n` +
    (ele !== null ? `    <ele>${ele}</ele>\n` : '') +
    (time ? `    <time>${time}</time>\n` : '') +
    xmlTag('name', wp.name) +
    xmlTag('desc', wp.note) +
    `    <extensions>\n${ext}    </extensions>\n` +
    `  </wpt>\n`
  );
}

function gpxTrack(track, points) {
  const segments = groupTrackPoints(points);
  const time = isoTime(track.startedAt || track.createdAt);
  let body = `  <trk>\n`;
  body += xmlTag('name', track.name, '    ');
  body += xmlTag('desc', track.note, '    ');
  body += `    <extensions>\n`;
  body += `      <gpsrec:coordinateSystem>${CRS_SHORT[track.__crs]}</gpsrec:coordinateSystem>\n`;
  if (Number.isFinite(track.stats?.distanceM)) {
    body += `      <gpsrec:distanceM>${fixed(track.stats.distanceM, 2)}</gpsrec:distanceM>\n`;
  }
  if (Number.isFinite(track.stats?.pointCount)) {
    body += `      <gpsrec:pointCount>${track.stats.pointCount}</gpsrec:pointCount>\n`;
  }
  body += sampleXml(track.sample);
  body += `    </extensions>\n`;

  for (const segment of segments) {
    body += `    <trkseg>\n`;
    for (const point of segment.points) {
      const pointTimeIso = isoTime(pointTime(point));
      const ele = fixed(point.altitudeM, 1);
      const extParts = [
        point.accuracyM != null
          ? `          <gpsrec:accuracyM>${fixed(point.accuracyM, 2)}</gpsrec:accuracyM>\n`
          : '',
        point.speedMps != null
          ? `          <gpsrec:speedMps>${fixed(point.speedMps, 2)}</gpsrec:speedMps>\n`
          : '',
        point.headingDeg != null
          ? `          <gpsrec:headingDeg>${fixed(point.headingDeg, 1)}</gpsrec:headingDeg>\n`
          : '',
      ].join('');
      body += `      <trkpt lat="${fixed(point.lat, 7)}" lon="${fixed(point.lng, 7)}">\n`;
      if (ele !== null) body += `        <ele>${ele}</ele>\n`;
      if (pointTimeIso) body += `        <time>${pointTimeIso}</time>\n`;
      if (extParts) body += `        <extensions>\n${extParts}        </extensions>\n`;
      body += `      </trkpt>\n`;
    }
    body += `    </trkseg>\n`;
  }
  body += `  </trk>\n`;

  return (
    XML_DECL +
    '\n' +
    `<gpx version="1.1" creator="点迹 GPS 记录器 ${escapeXml(APP_VERSION)}" ` +
    `xmlns="${GPX_NS}" xmlns:gpsrec="${EXT_NS}" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xsi:schemaLocation="${GPX_NS} ${GPX_XSD}">\n` +
    `  <metadata>\n` +
    xmlTag('name', track.name, '    ') +
    xmlTag('desc', track.note, '    ') +
    (time ? `    <time>${time}</time>\n` : '') +
    `  </metadata>\n` +
    body +
    `</gpx>\n`
  );
}

function serializeGpxWaypoint(wp) {
  const time = isoTime(pointTime(wp));
  return (
    XML_DECL +
    '\n' +
    `<gpx version="1.1" creator="点迹 GPS 记录器 ${escapeXml(APP_VERSION)}" ` +
    `xmlns="${GPX_NS}" xmlns:gpsrec="${EXT_NS}" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xsi:schemaLocation="${GPX_NS} ${GPX_XSD}">\n` +
    `  <metadata>\n` +
    xmlTag('name', wp.name, '    ') +
    (time ? `    <time>${time}</time>\n` : '') +
    `  </metadata>\n` +
    gpxWaypoint(wp) +
    `</gpx>\n`
  );
}

// ---------------------------------------------------------------------------
// KML
// ---------------------------------------------------------------------------

function kmlExtendedData(entries) {
  const rows = entries
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(
      ([name, value]) =>
        `      <Data name="${escapeXml(name)}"><value>${escapeXml(value)}</value></Data>\n`,
    )
    .join('');
  return rows ? `    <ExtendedData>\n${rows}    </ExtendedData>\n` : '';
}

function kmlCoordinate(point, includeAltitude) {
  const lon = fixed(point.lng, 7);
  const lat = fixed(point.lat, 7);
  if (includeAltitude) return `${lon},${lat},${fixed(point.altitudeM, 1)}`;
  return `${lon},${lat}`;
}

function kmlWaypoint(wp) {
  const time = isoTime(pointTime(wp));
  const hasAlt = Number.isFinite(wp.altitudeM);
  const data = kmlExtendedData([
    ['coordinateSystem', CRS_SHORT[wp.__crs]],
    ['accuracyM', wp.accuracyM != null ? fixed(wp.accuracyM, 2) : ''],
    ['speedMps', wp.speedMps != null ? fixed(wp.speedMps, 2) : ''],
    ['headingDeg', wp.headingDeg != null ? fixed(wp.headingDeg, 1) : ''],
    ['source', wp.source],
  ]);

  return (
    `  <Placemark>\n` +
    xmlTag('name', wp.name, '    ') +
    xmlTag('description', wp.note, '    ') +
    (time ? `    <TimeStamp><when>${time}</when></TimeStamp>\n` : '') +
    data +
    `    <Point>\n` +
    (hasAlt ? `      <altitudeMode>absolute</altitudeMode>\n` : '') +
    `      <coordinates>${kmlCoordinate(wp, hasAlt)}</coordinates>\n` +
    `    </Point>\n` +
    `  </Placemark>\n`
  );
}

function kmlLineString(segmentPoints, includeAltitude) {
  const coords = segmentPoints
    .map((point) => `        ${kmlCoordinate(point, includeAltitude)}`)
    .join('\n');
  return (
    `      <LineString>\n` +
    `        <tessellate>1</tessellate>\n` +
    (includeAltitude ? `        <altitudeMode>absolute</altitudeMode>\n` : '') +
    `        <coordinates>\n${coords}\n        </coordinates>\n` +
    `      </LineString>\n`
  );
}

/** 单点段用 Point 表示，避免生成非法的单坐标 LineString。 */
function kmlPointGeometry(point, includeAltitude) {
  return (
    `      <Point>\n` +
    (includeAltitude ? `        <altitudeMode>absolute</altitudeMode>\n` : '') +
    `        <coordinates>${kmlCoordinate(point, includeAltitude)}</coordinates>\n` +
    `      </Point>\n`
  );
}

function kmlSegmentGeometry(segmentPoints, includeAltitude) {
  if (segmentPoints.length >= 2) return kmlLineString(segmentPoints, includeAltitude);
  if (segmentPoints.length === 1) return kmlPointGeometry(segmentPoints[0], includeAltitude);
  return '';
}

function kmlTrack(track, points) {
  const segments = groupTrackPoints(points);
  const hasAlt = points.length > 0 && points.every((p) => Number.isFinite(p.altitudeM));
  const begin = isoTime(track.startedAt || track.createdAt);
  const end = isoTime(track.endedAt);
  const data = kmlExtendedData([
    ['coordinateSystem', CRS_SHORT[track.__crs]],
    ['distanceM', Number.isFinite(track.stats?.distanceM) ? fixed(track.stats.distanceM, 2) : ''],
    ['pointCount', track.stats?.pointCount ?? points.length],
    ['segmentCount', segments.length],
    [
      'sampling',
      track.sample
        ? `interval=${track.sample.minIntervalSec}s;distance=${track.sample.minDistanceM}m;accuracy=${track.sample.maxAccuracyM}m`
        : '',
    ],
    ['note', track.note],
  ]);

  let geometry = '';
  if (segments.length > 1) {
    geometry =
      `    <MultiGeometry>\n` +
      segments.map((segment) => kmlSegmentGeometry(segment.points, hasAlt)).join('') +
      `    </MultiGeometry>\n`;
  } else if (segments.length === 1) {
    geometry = kmlSegmentGeometry(segments[0].points, hasAlt);
  }

  return (
    `  <Placemark>\n` +
    xmlTag('name', track.name, '    ') +
    xmlTag('description', track.note, '    ') +
    (begin || end
      ? `    <TimeSpan>${begin ? `<begin>${begin}</begin>` : ''}${
          end ? `<end>${end}</end>` : ''
        }</TimeSpan>\n`
      : '') +
    data +
    geometry +
    `  </Placemark>\n`
  );
}

function wrapKml(documentName, body) {
  return (
    XML_DECL +
    '\n' +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n` +
    `<Document>\n` +
    xmlTag('name', documentName, '  ') +
    body +
    `</Document>\n</kml>\n`
  );
}

// ---------------------------------------------------------------------------
// GeoJSON
// ---------------------------------------------------------------------------

function jsonSafeNumber(value, digits) {
  const fixedValue = fixed(value, digits);
  return fixedValue === null ? null : Number(fixedValue);
}

function geojsonWaypoint(wp) {
  const hasAlt = Number.isFinite(wp.altitudeM);
  const coordinates = hasAlt
    ? [jsonSafeNumber(wp.lng, 7), jsonSafeNumber(wp.lat, 7), jsonSafeNumber(wp.altitudeM, 1)]
    : [jsonSafeNumber(wp.lng, 7), jsonSafeNumber(wp.lat, 7)];
  const feature = {
    type: 'Feature',
    properties: {
      kind: 'waypoint',
      name: wp.name || '',
      note: wp.note || '',
      createdAt: isoTime(wp.createdAt),
      time: isoTime(pointTime(wp)),
      altitudeM: Number.isFinite(wp.altitudeM) ? jsonSafeNumber(wp.altitudeM, 1) : null,
      accuracyM: wp.accuracyM != null ? jsonSafeNumber(wp.accuracyM, 2) : null,
      speedMps: wp.speedMps != null ? jsonSafeNumber(wp.speedMps, 2) : null,
      headingDeg: wp.headingDeg != null ? jsonSafeNumber(wp.headingDeg, 1) : null,
      source: wp.source || 'gps',
      coordinateSystem: CRS_SHORT[wp.__crs],
    },
    geometry: { type: 'Point', coordinates },
  };
  return JSON.stringify(feature, null, 2);
}

function geojsonTrack(track, points) {
  const segments = groupTrackPoints(points);
  const hasAlt = points.length > 0 && points.every((p) => Number.isFinite(p.altitudeM));
  const position = (point) => {
    const pair = [jsonSafeNumber(point.lng, 7), jsonSafeNumber(point.lat, 7)];
    if (hasAlt) pair.push(jsonSafeNumber(point.altitudeM, 1));
    return pair;
  };

  let geometry;
  if (points.length === 0) {
    geometry = { type: 'GeometryCollection', geometries: [] };
  } else if (segments.length === 1 && segments[0].points.length === 1) {
    geometry = { type: 'Point', coordinates: position(points[0]) };
  } else if (segments.every((s) => s.points.length >= 2)) {
    geometry =
      segments.length === 1
        ? { type: 'LineString', coordinates: segments[0].points.map(position) }
        : {
            type: 'MultiLineString',
            coordinates: segments.map((s) => s.points.map(position)),
          };
  } else {
    // 含单点分段：LineString 要求至少 2 个坐标，用 GeometryCollection 保留各段
    const geometries = segments.map((segment) =>
      segment.points.length >= 2
        ? { type: 'LineString', coordinates: segment.points.map(position) }
        : { type: 'Point', coordinates: position(segment.points[0]) },
    );
    geometry =
      geometries.length === 1
        ? geometries[0]
        : { type: 'GeometryCollection', geometries };
  }

  const feature = {
    type: 'Feature',
    properties: {
      kind: 'track',
      name: track.name || '',
      note: track.note || '',
      startedAt: isoTime(track.startedAt),
      endedAt: isoTime(track.endedAt),
      distanceM: Number.isFinite(track.stats?.distanceM)
        ? jsonSafeNumber(track.stats.distanceM, 2)
        : null,
      pointCount: track.stats?.pointCount ?? points.length,
      segmentCount: segments.length,
      sampling: track.sample || null,
      coordinateSystem: CRS_SHORT[track.__crs],
    },
    geometry,
  };
  return JSON.stringify(feature, null, 2);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 转义；文本字段防电子表格公式注入。 */
export function csvEscape(value, { formulaGuard = true } = {}) {
  let text = value === null || value === undefined ? '' : String(value);
  if (formulaGuard && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvRow(values) {
  return values.join(',') + '\r\n';
}

function serializeCsvWaypoint(wp) {
  const header = [
    'type',
    'name',
    'note',
    'lat',
    'lon',
    'altitude_m',
    'accuracy_m',
    'speed_mps',
    'heading_deg',
    'time_iso',
    'coordinate_system',
    'source',
  ];
  const row = [
    'waypoint',
    csvEscape(wp.name),
    csvEscape(wp.note),
    fixed(wp.lat, 7),
    fixed(wp.lng, 7),
    fixed(wp.altitudeM, 1) ?? '',
    fixed(wp.accuracyM, 2) ?? '',
    fixed(wp.speedMps, 2) ?? '',
    fixed(wp.headingDeg, 1) ?? '',
    isoTime(pointTime(wp)) ?? '',
    CRS_SHORT[wp.__crs],
    wp.source || 'gps',
  ];
  return `﻿${csvRow(header)}${csvRow(row)}`;
}

function serializeCsvTrack(track, points) {
  const header = [
    'track_name',
    'track_note',
    'segment',
    'seq',
    'lat',
    'lon',
    'altitude_m',
    'accuracy_m',
    'speed_mps',
    'heading_deg',
    'time_iso',
    'coordinate_system',
  ];
  let text = `﻿${csvRow(header)}`;
  for (const point of points) {
    text += csvRow([
      csvEscape(track.name),
      csvEscape(track.note),
      Number.isFinite(point.segment) ? point.segment : 0,
      Number.isFinite(point.seq) ? point.seq : '',
      fixed(point.lat, 7),
      fixed(point.lng, 7),
      fixed(point.altitudeM, 1) ?? '',
      fixed(point.accuracyM, 2) ?? '',
      fixed(point.speedMps, 2) ?? '',
      fixed(point.headingDeg, 1) ?? '',
      isoTime(pointTime(point)) ?? '',
      CRS_SHORT[track.__crs],
    ]);
  }
  return text;
}

// ---------------------------------------------------------------------------
// 纯文本（仅单点）
// ---------------------------------------------------------------------------

function serializeTextWaypoint(wp) {
  const time = formatDateTimeSec(pointTime(wp));
  return [
    `名称：${wp.name || '—'}`,
    `坐标系：${CRS_SHORT[wp.__crs]}`,
    `经纬度：${formatLatLng(wp)}`,
    `DMS：${formatDmsPair(wp)}`,
    `海拔：${Number.isFinite(wp.altitudeM) ? `${fixed(wp.altitudeM, 1)} m` : '—'}`,
    `精度：${wp.accuracyM != null ? `±${fixed(wp.accuracyM, 1)} m` : '—'}`,
    `速度：${wp.speedMps != null ? `${fixed(wp.speedMps * 3.6, 1)} km/h` : '—'}`,
    `时间：${time}`,
    `备注：${wp.note || '—'}`,
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

function prepareWaypoint(waypoint, crs) {
  const converted = convertCoord(waypoint, crs);
  return { ...waypoint, lat: converted.lat, lng: converted.lng, __crs: crs };
}

function prepareTrack(track, points, crs) {
  return {
    track: { ...track, __crs: crs },
    points: prepareTrackPoints(points, crs),
  };
}

/**
 * 序列化单点。
 * @param {object} waypoint
 * @param {{format?:string, crs?:'wgs84'|'gcj02'}} [options]
 */
export function serializeWaypoint(waypoint, { format = 'gpx', crs = 'wgs84' } = {}) {
  const fmt = resolveFormat(format);
  const prepared = prepareWaypoint(waypoint, resolveCrs(crs));
  switch (fmt.id) {
    case 'gpx':
      return serializeGpxWaypoint(prepared);
    case 'kml':
      return wrapKml(prepared.name || '单点', kmlWaypoint(prepared));
    case 'geojson':
      return geojsonWaypoint(prepared);
    case 'csv':
      return serializeCsvWaypoint(prepared);
    case 'txt':
      return serializeTextWaypoint(prepared);
    default:
      throw new Error(`不支持的导出格式：${format}`);
  }
}

/**
 * 序列化轨迹。
 * @param {object} track
 * @param {object[]} points
 * @param {{format?:string, crs?:'wgs84'|'gcj02'}} [options]
 */
export function serializeTrack(track, points, { format = 'gpx', crs = 'wgs84' } = {}) {
  const fmt = resolveFormat(format);
  if (fmt.waypointOnly) throw new Error(`${fmt.label} 格式仅支持单点导出`);
  const prepared = prepareTrack(track, points, resolveCrs(crs));
  switch (fmt.id) {
    case 'gpx':
      return gpxTrack(prepared.track, prepared.points);
    case 'kml':
      return wrapKml(prepared.track.name || '轨迹', kmlTrack(prepared.track, prepared.points));
    case 'geojson':
      return geojsonTrack(prepared.track, prepared.points);
    case 'csv':
      return serializeCsvTrack(prepared.track, prepared.points);
    default:
      throw new Error(`不支持的导出格式：${format}`);
  }
}

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 生成跨平台安全文件名片段（保留中文）。
 * @param {string} name
 * @param {string} fallback
 */
export function safeFilenamePart(name, fallback = 'item') {
  const cleaned = Array.from(String(name || '').normalize('NFC'))
    .map((ch) => {
      const code = ch.codePointAt(0);
      if (code < 0x20 || code === 0x7f) return '';
      if ('/\\:*?"<>|'.includes(ch)) return '_';
      return ch;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  let text = cleaned;

  if (!text || text === '.' || text === '..') text = fallback;
  if (RESERVED_NAMES.test(text)) text = `_${text}`;

  const chars = Array.from(text);
  if (chars.length > 40) text = chars.slice(0, 40).join('').trim() || fallback;
  return text;
}

function localStamp(ms) {
  const d = new Date(ms);
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * 文件名：gps-{kind}-{名称}-{YYYYMMDD-HHmmss}-{wgs84|gcj02}.{ext}
 * @param {'waypoint'|'track'} kind
 */
export function buildExportFilename(kind, name, timestampMs, crs, ext) {
  const safeKind = kind === 'track' ? 'track' : 'waypoint';
  const safeCrs = resolveCrs(crs);
  const safeName = safeFilenamePart(name, safeKind);
  return `gps-${safeKind}-${safeName}-${localStamp(timestampMs)}-${safeCrs}.${ext}`;
}

/**
 * 生成可直接用于分享/下载的完整导出对象。
 * @returns {{filename:string, mime:string, text:string, format:object}}
 */
export function buildWaypointFile(waypoint, { format = 'gpx', crs = 'wgs84' } = {}) {
  const fmt = resolveFormat(format);
  const text = serializeWaypoint(waypoint, { format, crs });
  return {
    filename: buildExportFilename(
      'waypoint',
      waypoint.name,
      waypoint.createdAt,
      crs,
      fmt.ext,
    ),
    mime: fmt.mime,
    text,
    format: fmt,
  };
}

/** @returns {{filename:string, mime:string, text:string, format:object}} */
export function buildTrackFile(track, points, { format = 'gpx', crs = 'wgs84' } = {}) {
  const fmt = resolveFormat(format);
  const text = serializeTrack(track, points, { format, crs });
  return {
    filename: buildExportFilename(
      'track',
      track.name,
      track.startedAt || track.createdAt,
      crs,
      fmt.ext,
    ),
    mime: fmt.mime,
    text,
    format: fmt,
  };
}
