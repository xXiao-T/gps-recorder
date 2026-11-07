/**
 * 领域数据访问层：单点、轨迹、轨迹点、设置。
 *
 * 数据约束：
 * - 所有坐标均为 WGS-84。
 * - 轨迹点与轨迹分开存储；每个点写入与轨迹统计更新在同一事务内完成。
 * - 暂停/信号中断/草稿恢复后开启新的 segment，导出与统计不跨段连线。
 */

import {
  requestGet,
  requestGetAll,
  requestGetAllByIndex,
  runTransaction,
} from './db.js';
import { defaultTrackName, defaultWaypointName } from './format.js';
import { isValidLatLng } from './geo.js';
import { normalizeSample } from './sampling.js';

const MAX_NAME_LENGTH = 200;
const MAX_NOTE_LENGTH = 2000;

function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requireCoordinate(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!isValidLatLng(latNum, lngNum)) {
    throw new Error('坐标无效：纬度需在 ±90、经度需在 ±180 范围内');
  }
  return { lat: latNum, lng: lngNum };
}

function normalizePointInput(input, trackId, seq, segment) {
  const { lat, lng } = requireCoordinate(input?.lat, input?.lng);
  const timestamp = Number(input?.timestamp);
  if (!Number.isFinite(timestamp)) throw new Error('轨迹点缺少有效时间戳');

  return {
    id: `${trackId}:${seq}`,
    trackId,
    seq,
    segment,
    lat,
    lng,
    altitudeM: finiteOrNull(input?.altitudeM),
    accuracyM: finiteOrNull(input?.accuracyM),
    speedMps: finiteOrNull(input?.speedMps),
    headingDeg: finiteOrNull(input?.headingDeg),
    timestamp,
    receivedAt: Number.isFinite(input?.receivedAt) ? input.receivedAt : Date.now(),
  };
}

function sortTracksDesc(tracks) {
  return [...tracks].sort(
    (a, b) =>
      (b.startedAt ?? b.createdAt ?? 0) - (a.startedAt ?? a.createdAt ?? 0),
  );
}

// ---------------------------------------------------------------------------
// 单点
// ---------------------------------------------------------------------------

/**
 * 保存一个坐标点。
 * @param {object} input {name?, note?, lat, lng, altitudeM?, accuracyM?, speedMps?, headingDeg?, fixAt?, source?}
 */
export async function addWaypoint(input) {
  const { lat, lng } = requireCoordinate(input?.lat, input?.lng);
  const now = Date.now();
  const waypoint = {
    id: uid(),
    name: cleanText(input?.name, MAX_NAME_LENGTH) || defaultWaypointName(now),
    note: cleanText(input?.note, MAX_NOTE_LENGTH),
    lat,
    lng,
    altitudeM: finiteOrNull(input?.altitudeM),
    accuracyM: finiteOrNull(input?.accuracyM),
    speedMps: finiteOrNull(input?.speedMps),
    headingDeg: finiteOrNull(input?.headingDeg),
    fixAt: finiteOrNull(input?.fixAt),
    createdAt: now,
    source: input?.source === 'map' ? 'map' : 'gps',
  };

  await runTransaction('waypoints', 'readwrite', (ctx) => {
    ctx.tx.objectStore('waypoints').add(waypoint);
    ctx.result = waypoint;
  });
  return waypoint;
}

/** 全部单点，按创建时间倒序。 */
export async function listWaypoints() {
  const waypoints = await requestGetAll('waypoints');
  return waypoints.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export function getWaypoint(id) {
  return requestGet('waypoints', id);
}

/** 只允许修改名称与备注。 */
export async function updateWaypoint(id, patch) {
  return runTransaction('waypoints', 'readwrite', (ctx) => {
    const store = ctx.tx.objectStore('waypoints');
    const request = store.get(id);
    request.onsuccess = () => {
      const existing = request.result;
      if (!existing) {
        ctx.fail(new Error('单点不存在或已被删除'));
        return;
      }
      const updated = {
        ...existing,
        ...(patch?.name !== undefined
          ? { name: cleanText(patch.name, MAX_NAME_LENGTH) || existing.name }
          : {}),
        ...(patch?.note !== undefined
          ? { note: cleanText(patch.note, MAX_NOTE_LENGTH) }
          : {}),
      };
      store.put(updated);
      ctx.result = updated;
    };
    request.onerror = () => ctx.fail(request.error);
  });
}

export async function deleteWaypoint(id) {
  return runTransaction('waypoints', 'readwrite', (ctx) => {
    ctx.tx.objectStore('waypoints').delete(id);
    ctx.result = true;
  });
}

// ---------------------------------------------------------------------------
// 轨迹
// ---------------------------------------------------------------------------

/**
 * 用首个被接受的点创建草稿轨迹（轨迹与首个点在同一个事务中写入）。
 * @param {object} params
 * @param {object} params.point
 * @param {object} params.sample
 * @param {string} [params.name]
 * @returns {Promise<{track:object, point:object}>}
 */
export async function createTrackDraft({ point, sample, name }) {
  const timestamp = Number(point?.timestamp);
  if (!Number.isFinite(timestamp)) throw new Error('首个轨迹点缺少有效时间戳');

  const trackId = uid();
  const now = Date.now();
  const firstPoint = normalizePointInput(point, trackId, 0, 0);
  const track = {
    id: trackId,
    name: cleanText(name, MAX_NAME_LENGTH) || defaultTrackName(timestamp),
    note: '',
    status: 'draft',
    createdAt: now,
    startedAt: timestamp,
    endedAt: null,
    updatedAt: now,
    activeMs: 0,
    segmentStartedAt: timestamp,
    currentSegment: 0,
    stats: { pointCount: 1, distanceM: 0 },
    sample: normalizeSample(sample),
  };

  await runTransaction(['tracks', 'trackPoints'], 'readwrite', (ctx) => {
    ctx.tx.objectStore('tracks').add(track);
    ctx.tx.objectStore('trackPoints').add(firstPoint);
    ctx.result = { track, point: firstPoint };
  });
  return { track, point: firstPoint };
}

/**
 * 追加一个被接受的点，并在同一事务中更新轨迹统计。
 * @param {string} trackId
 * @param {object} pointInput
 * @param {{distanceDeltaM?:number, isNewSegment?:boolean}} [options]
 */
export async function appendTrackPoint(trackId, pointInput, options = {}) {
  const distanceDeltaM = Math.max(0, Number(options.distanceDeltaM) || 0);
  const isNewSegment = Boolean(options.isNewSegment);

  return runTransaction(['tracks', 'trackPoints'], 'readwrite', (ctx) => {
    const trackStore = ctx.tx.objectStore('tracks');
    const pointStore = ctx.tx.objectStore('trackPoints');
    const request = trackStore.get(trackId);
    request.onsuccess = () => {
      const track = request.result;
      if (!track) {
        ctx.fail(new Error('轨迹不存在'));
        return;
      }
      if (track.status !== 'draft') {
        ctx.fail(new Error('轨迹已结束，不能继续写入'));
        return;
      }

      const seq = track.stats.pointCount;
      const segment = isNewSegment ? track.currentSegment + 1 : track.currentSegment;
      let point;
      try {
        point = normalizePointInput(pointInput, trackId, seq, segment);
      } catch (error) {
        ctx.fail(error);
        return;
      }

      const updated = {
        ...track,
        currentSegment: segment,
        segmentStartedAt: isNewSegment
          ? point.timestamp
          : track.segmentStartedAt ?? point.timestamp,
        updatedAt: Date.now(),
        stats: {
          pointCount: seq + 1,
          distanceM: track.stats.distanceM + (isNewSegment ? 0 : distanceDeltaM),
        },
      };

      pointStore.add(point);
      trackStore.put(updated);
      ctx.result = { track: updated, point };
    };
    request.onerror = () => ctx.fail(request.error);
  });
}

/**
 * 结束当前活跃段（暂停、GPS 中断、草稿恢复时调用），把本段时长归档进 activeMs。
 * @param {string} trackId
 * @param {number} [endAt]
 */
export async function closeSegment(trackId, endAt = Date.now()) {
  return runTransaction('tracks', 'readwrite', (ctx) => {
    const store = ctx.tx.objectStore('tracks');
    const request = store.get(trackId);
    request.onsuccess = () => {
      const track = request.result;
      if (!track) {
        ctx.fail(new Error('轨迹不存在'));
        return;
      }
      if (track.status !== 'draft') {
        ctx.result = track;
        return;
      }
      const segmentStartedAt = track.segmentStartedAt;
      const elapsed =
        Number.isFinite(segmentStartedAt) && Number.isFinite(endAt)
          ? Math.max(0, endAt - segmentStartedAt)
          : 0;
      const updated = {
        ...track,
        activeMs: (Number(track.activeMs) || 0) + elapsed,
        segmentStartedAt: null,
        updatedAt: Date.now(),
      };
      store.put(updated);
      ctx.result = updated;
    };
    request.onerror = () => ctx.fail(request.error);
  });
}

/**
 * 结束记录：归档当前段时长并标记为 completed。
 * @param {string} trackId
 * @param {{endedAt?:number, name?:string, note?:string}} [options]
 */
export async function completeTrack(trackId, options = {}) {
  const endedAt = Number.isFinite(options.endedAt) ? options.endedAt : Date.now();

  return runTransaction('tracks', 'readwrite', (ctx) => {
    const store = ctx.tx.objectStore('tracks');
    const request = store.get(trackId);
    request.onsuccess = () => {
      const track = request.result;
      if (!track) {
        ctx.fail(new Error('轨迹不存在'));
        return;
      }
      const segmentStartedAt = track.segmentStartedAt;
      const elapsed =
        Number.isFinite(segmentStartedAt) && track.status === 'draft'
          ? Math.max(0, endedAt - segmentStartedAt)
          : 0;
      const updated = {
        ...track,
        name:
          options.name !== undefined
            ? cleanText(options.name, MAX_NAME_LENGTH) || track.name
            : track.name,
        note:
          options.note !== undefined
            ? cleanText(options.note, MAX_NOTE_LENGTH)
            : track.note,
        status: 'completed',
        endedAt,
        updatedAt: Date.now(),
        activeMs: (Number(track.activeMs) || 0) + elapsed,
        segmentStartedAt: null,
      };
      store.put(updated);
      ctx.result = updated;
    };
    request.onerror = () => ctx.fail(request.error);
  });
}

export function getTrack(id) {
  return requestGet('tracks', id);
}

/** 全部轨迹（含草稿），按开始时间倒序。 */
export async function listTracks() {
  const tracks = await requestGetAll('tracks');
  return sortTracksDesc(tracks);
}

/** 未完成草稿；正常情况下最多一个。 */
export async function getDraft() {
  const tracks = await requestGetAll('tracks');
  return sortTracksDesc(tracks).find((track) => track.status === 'draft') || null;
}

/** 轨迹点，按 seq 升序。 */
export async function listTrackPoints(trackId) {
  const points = await requestGetAllByIndex('trackPoints', 'by_trackId', trackId);
  return points.sort((a, b) => a.seq - b.seq);
}

export async function getLastTrackPoint(trackId) {
  const points = await listTrackPoints(trackId);
  return points.length ? points[points.length - 1] : null;
}

export async function updateTrackMeta(id, patch) {
  return runTransaction('tracks', 'readwrite', (ctx) => {
    const store = ctx.tx.objectStore('tracks');
    const request = store.get(id);
    request.onsuccess = () => {
      const existing = request.result;
      if (!existing) {
        ctx.fail(new Error('轨迹不存在或已被删除'));
        return;
      }
      const updated = {
        ...existing,
        ...(patch?.name !== undefined
          ? { name: cleanText(patch.name, MAX_NAME_LENGTH) || existing.name }
          : {}),
        ...(patch?.note !== undefined
          ? { note: cleanText(patch.note, MAX_NOTE_LENGTH) }
          : {}),
        updatedAt: Date.now(),
      };
      store.put(updated);
      ctx.result = updated;
    };
    request.onerror = () => ctx.fail(request.error);
  });
}

/** 删除轨迹，并级联删除其所有轨迹点。 */
export async function deleteTrack(id) {
  return runTransaction(['tracks', 'trackPoints'], 'readwrite', (ctx) => {
    const pointStore = ctx.tx.objectStore('trackPoints');
    const index = pointStore.index('by_trackId');
    const cursorRequest = index.openCursor(IDBKeyRange.only(id));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
        return;
      }
      ctx.tx.objectStore('tracks').delete(id);
      ctx.result = true;
    };
    cursorRequest.onerror = () => ctx.fail(cursorRequest.error);
  });
}

// ---------------------------------------------------------------------------
// 统计与维护
// ---------------------------------------------------------------------------

/** 清除单点、轨迹、轨迹点，保留设置。 */
export async function clearUserData() {
  return runTransaction(['waypoints', 'tracks', 'trackPoints'], 'readwrite', (ctx) => {
    ctx.tx.objectStore('waypoints').clear();
    ctx.tx.objectStore('tracks').clear();
    ctx.tx.objectStore('trackPoints').clear();
    ctx.result = true;
  });
}

/** 各类数据数量，用于设置页展示。 */
export async function getDataCounts() {
  const waypoints = await requestGetAll('waypoints');
  const tracks = await requestGetAll('tracks');
  const points = await requestGetAll('trackPoints');
  return {
    waypoints: waypoints.length,
    tracks: tracks.length,
    points: points.length,
    drafts: tracks.filter((track) => track.status === 'draft').length,
  };
}

/** 测试与维护：暴露集合大小上限，供备份校验复用。 */
export const REPOSITORY_LIMITS = Object.freeze({
  maxNameLength: MAX_NAME_LENGTH,
  maxNoteLength: MAX_NOTE_LENGTH,
});
