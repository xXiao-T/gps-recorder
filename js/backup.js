/**
 * 全量备份与恢复。
 *
 * 备份格式与 IndexedDB 版本解耦；恢复前做严格校验，写入放在单个事务内，
 * 任一步失败都会整体回滚，不会留下半份数据。
 */

import {
  DEFAULT_PREFS,
  SAMPLE_LIMITS,
  SETTINGS_KEY,
} from './constants.js';
import { runTransaction } from './db.js';
import { haversineM, isValidLatLng } from './geo.js';
import { clearPrefsCache, validatePrefs } from './prefs.js';
import { normalizeSample } from './sampling.js';

export const BACKUP_APP = 'gps-recorder';
export const BACKUP_SCHEMA_VERSION = 1;
export const MAX_BACKUP_POINTS = 200_000;
export const MAX_BACKUP_ENTITIES = 5_000;
export const MAX_NAME_LENGTH = 200;
export const MAX_NOTE_LENGTH = 2000;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, maxLength) {
  const text = Array.from(String(value ?? ''))
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f);
    })
    .join('')
    .trim();
  return text.slice(0, maxLength);
}

function requireId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    fail(`${label} 无效`);
  }
  return value;
}

function requireFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} 无效`);
  return number;
}

function nullableFinite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function requireInt(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} 必须是非负整数`);
  return value;
}

function requireArray(value, label, limit) {
  if (!Array.isArray(value)) fail(`备份缺少 ${label} 数组`);
  if (value.length > limit) fail(`${label} 数量超过上限（${limit}）`);
  return value;
}

function clampSample(raw) {
  const sample = normalizeSample(raw);
  const clamp = (value, limits) => Math.min(limits.max, Math.max(limits.min, value));
  return {
    minIntervalSec: clamp(sample.minIntervalSec, SAMPLE_LIMITS.minIntervalSec),
    minDistanceM: clamp(sample.minDistanceM, SAMPLE_LIMITS.minDistanceM),
    maxAccuracyM: clamp(sample.maxAccuracyM, SAMPLE_LIMITS.maxAccuracyM),
  };
}

function normalizeWaypoint(raw, index) {
  if (!isPlainObject(raw)) fail(`第 ${index + 1} 个单点格式无效`);
  const id = requireId(raw.id, `第 ${index + 1} 个单点 id`);
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!isValidLatLng(lat, lng)) fail(`第 ${index + 1} 个单点坐标无效`);

  return {
    id,
    name: cleanText(raw.name, MAX_NAME_LENGTH) || '未命名单点',
    note: cleanText(raw.note, MAX_NOTE_LENGTH),
    lat,
    lng,
    altitudeM: nullableFinite(raw.altitudeM),
    accuracyM: nullableFinite(raw.accuracyM),
    speedMps: nullableFinite(raw.speedMps),
    headingDeg: nullableFinite(raw.headingDeg),
    fixAt: nullableFinite(raw.fixAt),
    createdAt: requireFinite(raw.createdAt, `第 ${index + 1} 个单点创建时间`),
    source: raw.source === 'map' ? 'map' : 'gps',
  };
}

function normalizeTrack(raw, index) {
  if (!isPlainObject(raw)) fail(`第 ${index + 1} 条轨迹格式无效`);
  const id = requireId(raw.id, `第 ${index + 1} 条轨迹 id`);
  const startedAt = requireFinite(raw.startedAt, `第 ${index + 1} 条轨迹开始时间`);
  const status = raw.status === 'draft' ? 'draft' : 'completed';

  return {
    id,
    name: cleanText(raw.name, MAX_NAME_LENGTH) || '未命名轨迹',
    note: cleanText(raw.note, MAX_NOTE_LENGTH),
    status,
    createdAt: nullableFinite(raw.createdAt) ?? startedAt,
    startedAt,
    endedAt: status === 'completed' ? nullableFinite(raw.endedAt) : null,
    updatedAt: nullableFinite(raw.updatedAt) ?? startedAt,
    activeMs: nonNegativeNumber(raw.activeMs, 0),
    segmentStartedAt:
      status === 'draft' ? nullableFinite(raw.segmentStartedAt) : null,
    currentSegment:
      Number.isInteger(raw.currentSegment) && raw.currentSegment >= 0
        ? raw.currentSegment
        : 0,
    stats: {
      pointCount: 0,
      distanceM: 0,
    },
    sample: clampSample(raw.sample),
  };
}

function normalizePoint(raw, index, trackId, seq, segment) {
  if (!isPlainObject(raw)) fail(`第 ${index + 1} 个轨迹点格式无效`);
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!isValidLatLng(lat, lng)) fail(`第 ${index + 1} 个轨迹点坐标无效`);
  const timestamp = requireFinite(raw.timestamp, `第 ${index + 1} 个轨迹点时间`);

  return {
    id: `${trackId}:${seq}`,
    trackId,
    seq,
    segment,
    lat,
    lng,
    altitudeM: nullableFinite(raw.altitudeM),
    accuracyM: nullableFinite(raw.accuracyM),
    speedMps: nullableFinite(raw.speedMps),
    headingDeg: nullableFinite(raw.headingDeg),
    timestamp,
    receivedAt: nullableFinite(raw.receivedAt) ?? timestamp,
  };
}

function computeDistance(points) {
  let distance = 0;
  let previous = null;
  let previousSegment = null;
  for (const point of points) {
    if (previous && point.segment === previousSegment) {
      distance += haversineM(previous, point);
    }
    previous = point;
    previousSegment = point.segment;
  }
  return distance;
}

/**
 * 校验并规范化备份数据。校验失败会抛出带中文原因的 Error。
 * @param {unknown} raw
 */
export function validateBackup(raw) {
  if (!isPlainObject(raw)) fail('备份文件不是有效的 JSON 对象');
  if (raw.app !== BACKUP_APP) fail('这不是点迹的备份文件');
  if (raw.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    if (Number(raw.schemaVersion) > BACKUP_SCHEMA_VERSION) {
      fail('备份来自更高的应用版本，请先升级后再恢复');
    }
    fail('备份版本不受支持');
  }

  const rawWaypoints = requireArray(raw.waypoints, 'waypoints', MAX_BACKUP_ENTITIES);
  const rawTracks = requireArray(raw.tracks, 'tracks', MAX_BACKUP_ENTITIES);
  const rawPoints = requireArray(raw.trackPoints, 'trackPoints', MAX_BACKUP_POINTS);

  const waypointIds = new Set();
  const waypoints = rawWaypoints.map((item, index) => {
    const waypoint = normalizeWaypoint(item, index);
    if (waypointIds.has(waypoint.id)) fail(`单点 id 重复：${waypoint.id}`);
    waypointIds.add(waypoint.id);
    return waypoint;
  });

  const trackIds = new Set();
  const tracks = rawTracks.map((item, index) => {
    const track = normalizeTrack(item, index);
    if (trackIds.has(track.id)) fail(`轨迹 id 重复：${track.id}`);
    trackIds.add(track.id);
    return track;
  });
  const trackById = new Map(tracks.map((track) => [track.id, track]));

  const seenKeys = new Set();
  const pointsByTrack = new Map();
  const points = rawPoints.map((item, index) => {
    if (!isPlainObject(item)) fail(`第 ${index + 1} 个轨迹点格式无效`);
    const trackId = requireId(item.trackId, `第 ${index + 1} 个轨迹点的 trackId`);
    if (!trackById.has(trackId)) fail(`轨迹点引用了不存在的轨迹：${trackId}`);
    const seq = requireInt(item.seq, `第 ${index + 1} 个轨迹点 seq`);
    const segment = requireInt(item.segment, `第 ${index + 1} 个轨迹点 segment`);
    const key = `${trackId}:${seq}`;
    if (seenKeys.has(key)) fail(`轨迹点序号重复：${key}`);
    seenKeys.add(key);

    const point = normalizePoint(item, index, trackId, seq, segment);
    if (!pointsByTrack.has(trackId)) pointsByTrack.set(trackId, []);
    pointsByTrack.get(trackId).push(point);
    return point;
  });

  for (const track of tracks) {
    const trackPoints = (pointsByTrack.get(track.id) || []).sort((a, b) => a.seq - b.seq);
    const maxSegment = trackPoints.reduce(
      (max, point) => Math.max(max, point.segment),
      0,
    );
    track.stats.pointCount = trackPoints.length;
    track.stats.distanceM = computeDistance(trackPoints);
    track.currentSegment = Math.max(track.currentSegment, maxSegment);
    if (track.status === 'completed' && !Number.isFinite(track.endedAt)) {
      track.endedAt = trackPoints.length
        ? trackPoints[trackPoints.length - 1].timestamp
        : track.startedAt;
    }
  }

  return {
    app: BACKUP_APP,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt:
      typeof raw.exportedAt === 'string' ? raw.exportedAt : new Date().toISOString(),
    preferences: validatePrefs(raw.preferences),
    waypoints,
    tracks,
    trackPoints: points,
  };
}

/** 生成当前数据的备份对象。 */
export async function createBackup() {
  const snapshot = await runTransaction(
    ['waypoints', 'tracks', 'trackPoints', 'settings'],
    'readonly',
    (ctx) => {
      const names = ['waypoints', 'tracks', 'trackPoints', 'settings'];
      const data = {};
      let remaining = names.length;
      for (const name of names) {
        const request = ctx.tx.objectStore(name).getAll();
        request.onsuccess = () => {
          data[name] = request.result;
          remaining -= 1;
          if (remaining > 0) return;

          const prefRecord = data.settings.find((item) => item.key === SETTINGS_KEY);
          ctx.result = {
            app: BACKUP_APP,
            schemaVersion: BACKUP_SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            preferences: validatePrefs(prefRecord?.value ?? DEFAULT_PREFS),
            waypoints: data.waypoints
              .slice()
              .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
            tracks: data.tracks
              .slice()
              .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
            trackPoints: data.trackPoints
              .slice()
              .sort(
                (a, b) =>
                  String(a.trackId).localeCompare(String(b.trackId)) || a.seq - b.seq,
              ),
          };
        };
        request.onerror = () => ctx.fail(request.error || new Error('备份读取失败'));
      }
    },
  );
  return snapshot;
}

/** 恢复备份为全量替换；失败自动回滚并保留原数据。 */
export async function restoreBackup(raw) {
  const data = validateBackup(raw);

  const counts = await runTransaction(
    ['waypoints', 'tracks', 'trackPoints', 'settings'],
    'readwrite',
    (ctx) => {
      const waypointStore = ctx.tx.objectStore('waypoints');
      const trackStore = ctx.tx.objectStore('tracks');
      const pointStore = ctx.tx.objectStore('trackPoints');
      const settingsStore = ctx.tx.objectStore('settings');

      waypointStore.clear();
      trackStore.clear();
      pointStore.clear();
      settingsStore.clear();

      for (const waypoint of data.waypoints) waypointStore.put(waypoint);
      for (const track of data.tracks) trackStore.put(track);
      for (const point of data.trackPoints) pointStore.put(point);
      settingsStore.put({
        key: SETTINGS_KEY,
        value: data.preferences,
        updatedAt: Date.now(),
      });

      ctx.result = {
        waypoints: data.waypoints.length,
        tracks: data.tracks.length,
        points: data.trackPoints.length,
      };
    },
  );

  clearPrefsCache();
  return counts;
}

/** 备份文件名（本地时间）。 */
export function buildBackupFilename(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `dianji-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.json`
  );
}
