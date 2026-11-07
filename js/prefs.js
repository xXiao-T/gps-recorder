/**
 * 用户设置：IndexedDB 单一数据源，带默认值合并与范围校验。
 */

import { DEFAULT_PREFS, SAMPLE_LIMITS, SETTINGS_KEY } from './constants.js';
import { requestGet, runTransaction } from './db.js';

let cachedPrefs = null;

function clamp(value, { min, max }, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * 合并默认值并做合法性校验。
 * @param {object} raw
 * @returns {typeof DEFAULT_PREFS}
 */
export function validatePrefs(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const sample =
    source.sampleDefaults && typeof source.sampleDefaults === 'object'
      ? source.sampleDefaults
      : {};

  return {
    exportCrs: source.exportCrs === 'gcj02' ? 'gcj02' : 'wgs84',
    sampleDefaults: {
      minIntervalSec: clamp(
        sample.minIntervalSec,
        SAMPLE_LIMITS.minIntervalSec,
        DEFAULT_PREFS.sampleDefaults.minIntervalSec,
      ),
      minDistanceM: clamp(
        sample.minDistanceM,
        SAMPLE_LIMITS.minDistanceM,
        DEFAULT_PREFS.sampleDefaults.minDistanceM,
      ),
      maxAccuracyM: clamp(
        sample.maxAccuracyM,
        SAMPLE_LIMITS.maxAccuracyM,
        DEFAULT_PREFS.sampleDefaults.maxAccuracyM,
      ),
    },
    keepAwake:
      typeof source.keepAwake === 'boolean' ? source.keepAwake : DEFAULT_PREFS.keepAwake,
    autoFollow:
      typeof source.autoFollow === 'boolean' ? source.autoFollow : DEFAULT_PREFS.autoFollow,
    basemap: source.basemap === 'satellite' ? 'satellite' : 'vector',
  };
}

/** 读取设置；失败时回退到默认值。 */
export async function loadPrefs({ force = false } = {}) {
  if (cachedPrefs && !force) return cachedPrefs;
  try {
    const record = await requestGet('settings', SETTINGS_KEY);
    cachedPrefs = validatePrefs(record?.value);
  } catch {
    cachedPrefs = validatePrefs(null);
  }
  return cachedPrefs;
}

/** 同步获取已加载的设置（未加载时返回默认值）。 */
export function getCachedPrefs() {
  return validatePrefs(cachedPrefs);
}

/**
 * 合并并保存设置。
 * @param {Partial<typeof DEFAULT_PREFS>} patch
 */
export async function savePrefs(patch) {
  const base = await loadPrefs();
  const merged = validatePrefs({
    ...base,
    ...(patch && typeof patch === 'object' ? patch : {}),
    sampleDefaults: {
      ...base.sampleDefaults,
      ...(patch?.sampleDefaults && typeof patch.sampleDefaults === 'object'
        ? patch.sampleDefaults
        : {}),
    },
  });

  await runTransaction('settings', 'readwrite', (ctx) => {
    ctx.tx.objectStore('settings').put({
      key: SETTINGS_KEY,
      value: merged,
      updatedAt: Date.now(),
    });
    ctx.result = merged;
  });

  cachedPrefs = merged;
  return merged;
}

export function clearPrefsCache() {
  cachedPrefs = null;
}
