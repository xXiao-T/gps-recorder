/**
 * 轨迹记录器状态机（不依赖 DOM 与 Leaflet）。
 *
 * 状态：idle → acquiring → recording ⇄ paused → ending → idle
 * - 采样只由 watchPosition 回调驱动，不用定时器造点。
 * - 每个被接受的点立即写 IndexedDB；页面刷新/崩溃后可恢复草稿。
 * - 暂停、GPS 中断、草稿恢复后的首个点开启新 segment，统计不跨段连线。
 */

import { haversineM } from './geo.js';
import {
  startWatch,
  stopWatch,
} from './location.js';
import { getCachedPrefs, loadPrefs } from './prefs.js';
import {
  appendTrackPoint,
  closeSegment,
  completeTrack,
  createTrackDraft,
  deleteTrack,
  getDraft,
  getLastTrackPoint,
} from './repository.js';
import {
  activeDurationMs,
  averageSpeedMps,
  detectGap,
  evaluateSample,
  normalizeSample,
} from './sampling.js';

const state = {
  status: 'idle',
  track: null,
  latestFix: null,
  lastAccepted: null, // {lat, lng, timestamp, segment}
  lastFixAt: null,
  pendingSegment: false,
  sample: null,
  keepAwake: true,
  error: null,
  wakeLock: 'off',
  lastCompleted: null,
  token: 0,
};

let startName = null;
let starting = false;
let writeChain = Promise.resolve();
let wakeLockSentinel = null;
const listeners = new Set();

// ---------------------------------------------------------------------------
// 通知与队列
// ---------------------------------------------------------------------------

function snapshot(now = Date.now()) {
  const track = state.track;
  const activeMs = track ? activeDurationMs(track, now) : 0;
  return {
    status: state.status,
    track,
    latestFix: state.latestFix,
    lastAccepted: state.lastAccepted,
    error: state.error,
    sample: state.sample || track?.sample || null,
    keepAwake: state.keepAwake,
    wakeLock: state.wakeLock,
    pendingSegment: state.pendingSegment,
    pointCount: track?.stats?.pointCount ?? 0,
    distanceM: track?.stats?.distanceM ?? 0,
    activeMs,
    averageSpeedMps:
      track && track.stats ? averageSpeedMps(track.stats.distanceM, activeMs) : null,
    lastCompleted: state.lastCompleted,
  };
}

function notify() {
  const current = snapshot();
  for (const listener of listeners) {
    try {
      listener(current);
    } catch (error) {
      console.error('recorder listener failed', error);
    }
  }
}

function enqueue(task) {
  const result = writeChain.then(task);
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function handleStorageError(error) {
  state.error = {
    code: 'storage',
    message: error?.message || '本地保存失败，请检查浏览器存储空间',
  };
  if (state.status === 'acquiring' || state.status === 'recording') {
    stopWatch();
    void releaseWakeLock();
    state.status = state.track ? 'paused' : 'idle';
  }
  notify();
}

function queueFix(task) {
  enqueue(task).catch(handleStorageError);
}

export function subscribe(listener) {
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}

export function getSnapshot(now = Date.now()) {
  return snapshot(now);
}

export function isActive() {
  return state.status === 'acquiring' || state.status === 'recording';
}

// ---------------------------------------------------------------------------
// Wake Lock
// ---------------------------------------------------------------------------

async function requestWakeLock() {
  if (!state.keepAwake) {
    if (wakeLockSentinel) await releaseWakeLock();
    state.wakeLock = 'off';
    notify();
    return;
  }
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
    state.wakeLock = 'unsupported';
    notify();
    return;
  }
  if (wakeLockSentinel) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    state.wakeLock = 'active';
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
      if (state.wakeLock === 'active') state.wakeLock = 'released';
      notify();
    });
  } catch {
    state.wakeLock = 'error';
  }
  notify();
}

async function releaseWakeLock() {
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch {
      /* 浏览器可能已经自动释放 */
    }
    wakeLockSentinel = null;
  }
  state.wakeLock = 'off';
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      isActive() &&
      state.keepAwake
    ) {
      void requestWakeLock();
    }
  });
}

// ---------------------------------------------------------------------------
// 定位回调与采样
// ---------------------------------------------------------------------------

function handleLocationError(error) {
  state.error = {
    code: error?.code || 'location',
    message: error?.message || '定位失败',
  };

  if (['denied', 'unsupported', 'insecure'].includes(error.code)) {
    // 先阻止新 fix 入队；若有正在写入的首个点，等队列结束后再落定状态。
    state.token += 1;
    stopWatch();
    void releaseWakeLock();
    const endAt =
      state.lastAccepted?.timestamp ?? state.latestFix?.timestamp ?? Date.now();
    state.status = 'paused';
    notify();

    enqueue(async () => {
      if (!state.track) {
        resetToIdle();
        notify();
        return;
      }
      state.track = await closeSegment(state.track.id, endAt);
      notify();
    }).catch(handleStorageError);
    return;
  }
  notify();
}

function handleFix(fix) {
  state.latestFix = fix;
  // 收到新 fix 说明定位恢复，清掉超时/暂不可用等临时错误（存储错误保留）。
  if (state.error && state.error.code !== 'storage') state.error = null;
  notify();

  if (state.status !== 'acquiring' && state.status !== 'recording') return;
  const token = state.token;
  queueFix(() => processFix(fix, token));
}

async function processFix(fix, token) {
  if (token !== state.token) return;
  if (state.status !== 'acquiring' && state.status !== 'recording') return;

  const sample = state.sample;
  const previousFixAt = state.lastFixAt;

  // 记录中检测原始定位中断：关闭当前段，当前点开启新段。
  if (state.status === 'recording' && state.track && previousFixAt !== null) {
    if (detectGap(previousFixAt, fix.receivedAt, sample.minIntervalSec)) {
      const endAt = state.lastAccepted?.timestamp ?? previousFixAt;
      try {
        state.track = await closeSegment(state.track.id, endAt);
        state.pendingSegment = true;
        notify();
      } catch (error) {
        handleStorageError(error);
        return;
      }
    }
  }

  state.lastFixAt = fix.receivedAt;

  if (state.status === 'acquiring') {
    const result = evaluateSample({
      fix,
      lastAccepted: null,
      isNewSegment: true,
      sample,
    });
    if (!result.accepted) {
      notify();
      return;
    }

    try {
      if (!state.track) {
        const created = await createTrackDraft({
          point: fix,
          sample,
          name: startName,
        });
        state.track = created.track;
        state.sample = created.track.sample;
      } else {
        const appended = await appendTrackPoint(state.track.id, fix, {
          isNewSegment: true,
          distanceDeltaM: 0,
        });
        state.track = appended.track;
      }
    } catch (error) {
      handleStorageError(error);
      return;
    }

    state.lastAccepted = {
      lat: fix.lat,
      lng: fix.lng,
      timestamp: fix.timestamp,
      segment: state.track.currentSegment,
    };
    state.pendingSegment = false;
    if (state.status === 'acquiring') state.status = 'recording';
    notify();
    return;
  }

  // recording
  const isNewSegment = state.pendingSegment;
  const result = evaluateSample({
    fix,
    lastAccepted: isNewSegment ? null : state.lastAccepted,
    isNewSegment,
    sample,
  });
  if (!result.accepted) {
    notify();
    return;
  }

  const distanceDeltaM =
    isNewSegment || !state.lastAccepted ? 0 : haversineM(state.lastAccepted, fix);

  try {
    const appended = await appendTrackPoint(state.track.id, fix, {
      isNewSegment,
      distanceDeltaM,
    });
    state.track = appended.track;
    state.lastAccepted = {
      lat: fix.lat,
      lng: fix.lng,
      timestamp: fix.timestamp,
      segment: appended.point.segment,
    };
    state.pendingSegment = false;
  } catch (error) {
    handleStorageError(error);
    return;
  }
  notify();
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

function resetToIdle({ clearFix = true } = {}) {
  state.status = 'idle';
  state.track = null;
  state.lastAccepted = null;
  state.lastFixAt = null;
  state.pendingSegment = false;
  state.sample = null;
  state.error = null;
  startName = null;
  if (clearFix) state.latestFix = null;
}

/**
 * 开始一次新的轨迹记录；第一个通过精度检查的点会创建草稿。
 * @param {object} sampleInput
 * @param {{name?:string}} [options]
 */
export async function start(sampleInput, options = {}) {
  if (starting) throw new Error('正在开始记录，请稍候');
  if (state.status !== 'idle' || state.track) {
    throw new Error('已有记录正在进行');
  }

  starting = true;
  try {
    const draft = await getDraft();
    if (draft) {
      throw new Error('存在未完成的轨迹，请先恢复、结束或删除草稿');
    }
    await loadPrefs();
    const prefs = getCachedPrefs();
    const sample = normalizeSample(sampleInput ?? prefs.sampleDefaults);

    state.token += 1;
    state.status = 'acquiring';
    state.track = null;
    state.latestFix = null;
    state.lastAccepted = null;
    state.lastFixAt = null;
    state.pendingSegment = false;
    state.sample = sample;
    state.keepAwake = prefs.keepAwake;
    state.error = null;
    state.lastCompleted = null;
    startName = options.name || null;
    notify();

    try {
      startWatch({ onFix: handleFix, onError: handleLocationError });
    } catch (error) {
      state.status = 'idle';
      state.error = {
        code: error.code || 'location',
        message: error.message || '无法开始定位',
      };
      notify();
      throw error;
    }

    void requestWakeLock();
    notify();
  } finally {
    starting = false;
  }
}

/** 暂停记录；无轨迹时等同于取消。 */
export async function pause() {
  if (state.status !== 'acquiring' && state.status !== 'recording') return;

  state.token += 1;
  stopWatch();
  void releaseWakeLock();

  if (!state.track) {
    resetToIdle();
    notify();
    return;
  }

  state.status = 'paused';
  state.lastFixAt = null;
  notify();

  try {
    await enqueue(async () => {
      if (!state.track) return;
      state.track = await closeSegment(state.track.id, Date.now());
      notify();
    });
  } catch (error) {
    handleStorageError(error);
  }
}

/** 从暂停状态继续，第一个新点开启新 segment。 */
export async function resume() {
  if (state.status !== 'paused' || !state.track) return;

  await loadPrefs();
  state.token += 1;
  state.status = 'acquiring';
  state.pendingSegment = true;
  state.lastFixAt = null;
  state.error = null;
  state.keepAwake = getCachedPrefs().keepAwake;
  notify();

  try {
    startWatch({ onFix: handleFix, onError: handleLocationError });
  } catch (error) {
    state.status = 'paused';
    state.error = {
      code: error.code || 'location',
      message: error.message || '无法继续定位',
    };
    notify();
    return;
  }
  void requestWakeLock();
  notify();
}

/**
 * 结束记录并保存为 completed；返回已完成轨迹（无轨迹时返回 null）。
 */
export async function stop() {
  if (
    state.status !== 'acquiring' &&
    state.status !== 'recording' &&
    state.status !== 'paused'
  ) {
    return null;
  }

  state.token += 1;
  stopWatch();
  void releaseWakeLock();

  if (!state.track) {
    resetToIdle();
    notify();
    return null;
  }

  state.status = 'ending';
  state.lastFixAt = null;
  notify();

  try {
    const completed = await enqueue(async () => {
      if (!state.track) return null;
      return completeTrack(state.track.id, { endedAt: Date.now() });
    });
    state.lastCompleted = completed;
    resetToIdle();
    notify();
    return completed;
  } catch (error) {
    state.status = 'paused';
    handleStorageError(error);
    return null;
  }
}

/** 尝试重新连接定位；记录中会先关闭当前段，下一有效点开新段。 */
export async function retry() {
  if (
    state.status !== 'acquiring' &&
    state.status !== 'recording' &&
    state.status !== 'paused'
  ) {
    return;
  }

  const oldTrack = state.track;
  const endAt =
    state.lastAccepted?.timestamp ?? state.latestFix?.timestamp ?? Date.now();

  state.token += 1;
  stopWatch();
  state.error = null;

  if (oldTrack && Number.isFinite(oldTrack.segmentStartedAt)) {
    enqueue(async () => {
      if (!state.track) return;
      state.track = await closeSegment(state.track.id, endAt);
      notify();
    }).catch(handleStorageError);
  }

  state.status = 'acquiring';
  state.pendingSegment = true;
  state.lastFixAt = null;
  notify();

  try {
    startWatch({ onFix: handleFix, onError: handleLocationError });
  } catch (error) {
    state.status = oldTrack ? 'paused' : 'idle';
    state.error = {
      code: error.code || 'location',
      message: error.message || '无法重新连接定位',
    };
    notify();
    return;
  }
  void requestWakeLock();
  notify();
}

/**
 * 恢复草稿并立即继续记录：关闭上次未归档的段，下一个点开新段。
 * @param {object} track 草稿轨迹
 */
export async function recoverAndResume(track) {
  if (starting) throw new Error('正在开始记录，请稍候');
  if (state.status !== 'idle' || state.track) {
    throw new Error('已有记录正在进行');
  }

  starting = true;
  try {
    await loadPrefs();
    const prefs = getCachedPrefs();
    const lastPoint = await getLastTrackPoint(track.id);

    let recovered = track;
    if (Number.isFinite(track.segmentStartedAt)) {
      const endAt = Number.isFinite(lastPoint?.timestamp)
        ? lastPoint.timestamp
        : Date.now();
      recovered = await closeSegment(track.id, endAt);
    }

    state.token += 1;
    state.status = 'acquiring';
    state.track = recovered;
    state.latestFix = null;
    state.lastAccepted = lastPoint
      ? {
          lat: lastPoint.lat,
          lng: lastPoint.lng,
          timestamp: lastPoint.timestamp,
          segment: lastPoint.segment,
        }
      : null;
    state.lastFixAt = null;
    state.pendingSegment = true;
    state.sample = normalizeSample(recovered.sample);
    state.keepAwake = prefs.keepAwake;
    state.error = null;
    state.lastCompleted = null;
    startName = null;
    notify();

    try {
      startWatch({ onFix: handleFix, onError: handleLocationError });
    } catch (error) {
      state.status = 'paused';
      state.error = {
        code: error.code || 'location',
        message: error.message || '无法继续定位',
      };
      notify();
      return;
    }
    void requestWakeLock();
    notify();
  } finally {
    starting = false;
  }
}

/** 结束草稿并保存（不继续记录）。 */
export async function finishDraft(track) {
  if (state.status !== 'idle' || state.track) {
    throw new Error('记录进行中，不能直接结束草稿');
  }
  const lastPoint = await getLastTrackPoint(track.id);
  let current = track;
  if (Number.isFinite(track.segmentStartedAt)) {
    const endAt = Number.isFinite(lastPoint?.timestamp)
      ? lastPoint.timestamp
      : Date.now();
    current = await closeSegment(track.id, endAt);
  }
  const completed = await completeTrack(current.id, { endedAt: Date.now() });
  state.lastCompleted = completed;
  notify();
  return completed;
}

/** 删除草稿。 */
export async function discardDraft(trackId) {
  await deleteTrack(trackId);
  notify();
}

/** 清除上一次结束的摘要，避免页面重复展示。 */
export function clearCompleted() {
  state.lastCompleted = null;
  notify();
}

/** 记录中修改“保持屏幕常亮”。 */
export async function setKeepAwake(enabled) {
  state.keepAwake = Boolean(enabled);
  if (enabled && isActive()) {
    await requestWakeLock();
  } else if (!enabled) {
    await releaseWakeLock();
  }
  notify();
}
