/**
 * 采样判定（纯函数）。
 *
 * 规则（三者同时满足才记录）：
 * 1. 定位精度 ≤ maxAccuracyM（0 表示关闭；accuracyM 缺失且阈值开启时拒绝）；
 * 2. 距上一个被接受点的时间 ≥ minIntervalSec（0 表示关闭）；
 * 3. 距上一个被接受点的位移 ≥ minDistanceM（0 表示关闭）。
 *
 * 新段（segment）的首个点只需通过精度校验，不要求时间与距离。
 */

import { GPS_GAP_BASE_MS } from './constants.js';
import { haversineM, isValidLatLng } from './geo.js';

/** 把未定义的采样参数补成安全值。 */
export function normalizeSample(input = {}) {
  const number = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    minIntervalSec: number(input.minIntervalSec, 5),
    minDistanceM: number(input.minDistanceM, 3),
    maxAccuracyM: number(input.maxAccuracyM, 30),
  };
}

/**
 * 判断一个原始定位点是否可以写入轨迹。
 * @param {object} params
 * @param {{lat:number,lng:number,accuracyM:number|null,timestamp:number}} params.fix
 * @param {{lat:number,lng:number,timestamp:number}|null} params.lastAccepted
 * @param {boolean} params.isNewSegment 下一个点是否开启新段
 * @param {{minIntervalSec:number,minDistanceM:number,maxAccuracyM:number}} params.sample
 * @returns {{accepted:boolean,reason:string,distanceM:number|null}}
 */
export function evaluateSample({ fix, lastAccepted, isNewSegment, sample }) {
  if (
    !fix ||
    !isValidLatLng(fix.lat, fix.lng) ||
    !Number.isFinite(fix.timestamp)
  ) {
    return { accepted: false, reason: 'invalid', distanceM: null };
  }

  const maxAccuracy = Number(sample?.maxAccuracyM) || 0;
  if (maxAccuracy > 0) {
    if (!Number.isFinite(fix.accuracyM)) {
      return { accepted: false, reason: 'accuracy-missing', distanceM: null };
    }
    if (fix.accuracyM > maxAccuracy) {
      return { accepted: false, reason: 'accuracy-exceeded', distanceM: null };
    }
  }

  if (!lastAccepted || isNewSegment) {
    return { accepted: true, reason: 'segment-start', distanceM: null };
  }

  if (fix.timestamp <= lastAccepted.timestamp) {
    return { accepted: false, reason: 'stale-timestamp', distanceM: null };
  }

  const distanceM = haversineM(lastAccepted, fix);
  const minIntervalSec = Number(sample?.minIntervalSec) || 0;
  const minDistanceM = Number(sample?.minDistanceM) || 0;

  if (
    minIntervalSec > 0 &&
    fix.timestamp - lastAccepted.timestamp < minIntervalSec * 1000
  ) {
    return { accepted: false, reason: 'too-soon', distanceM };
  }
  if (minDistanceM > 0 && distanceM < minDistanceM) {
    return { accepted: false, reason: 'too-close', distanceM };
  }

  return { accepted: true, reason: 'sampled', distanceM };
}

/**
 * 原始定位信号是否中断。
 * 阈值 = max(30 秒, 3 × 采样时间间隔)。
 * @param {number|null} lastFixAt 上一个原始 fix 的接收时间（不是被接受点）
 * @param {number} fixAt 当前 fix 的接收时间
 * @param {number} minIntervalSec
 */
export function detectGap(lastFixAt, fixAt, minIntervalSec = 0) {
  if (!Number.isFinite(lastFixAt) || !Number.isFinite(fixAt)) return false;
  const threshold = Math.max(
    GPS_GAP_BASE_MS,
    3 * Math.max(0, Number(minIntervalSec) || 0) * 1000,
  );
  return fixAt - lastFixAt > threshold;
}

/** 平均速度（m/s）；活跃时长为 0 时返回 null。 */
export function averageSpeedMps(distanceM, activeMs) {
  if (!Number.isFinite(distanceM) || !Number.isFinite(activeMs) || activeMs <= 0) {
    return null;
  }
  return distanceM / (activeMs / 1000);
}

/**
 * 计算轨迹当前活跃时长。
 * @param {{activeMs?:number,segmentStartedAt?:number|null}} track
 * @param {number} now
 */
export function activeDurationMs(track, now = Date.now()) {
  const base = Number(track?.activeMs) || 0;
  const started = track?.segmentStartedAt;
  if (!Number.isFinite(started)) return base;
  return base + Math.max(0, now - started);
}
