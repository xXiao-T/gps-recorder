/**
 * 界面展示格式化（纯函数，无 DOM 依赖）。
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 时长：小时存在时 H:MM:SS，否则 MM:SS。 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

/** 距离：<1 km 显示米，否则公里。10 m 以下保留 1 位小数。 */
export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1000) {
    if (meters < 10) return `${meters.toFixed(1)} m`;
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(2)} km`;
}

/** 速度：m/s → km/h。 */
export function formatSpeed(mps) {
  if (!Number.isFinite(mps) || mps < 0) return '—';
  const kmh = mps * 3.6;
  return `${kmh < 10 ? kmh.toFixed(1) : Math.round(kmh)} km/h`;
}

/** 平均速度 m/s → km/h 文本。 */
export function formatAverageSpeed(distanceM, activeMs) {
  if (!Number.isFinite(distanceM) || !Number.isFinite(activeMs) || activeMs <= 0) {
    return '—';
  }
  return formatSpeed(distanceM / (activeMs / 1000));
}

/** 精度：±12 m。 */
export function formatAccuracy(meters) {
  if (!Number.isFinite(meters)) return '—';
  return `±${Math.round(meters)} m`;
}

/** 本地时间 YYYY-MM-DD HH:mm。 */
export function formatDateTime(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

/** 本地时间 YYYY-MM-DD HH:mm:ss。 */
export function formatDateTimeSec(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return `${formatDateTime(ms)}:${pad2(d.getSeconds())}`;
}

/** 紧凑时间 MM-DD HH:mm，用于默认名称。 */
export function formatDateShort(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}`;
}

/** ISO 8601 UTC，用于导出。 */
export function isoTime(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** 默认单点名称：定位点 11-07 14:32。 */
export function defaultWaypointName(ms = Date.now()) {
  return `定位点 ${formatDateShort(ms)}`;
}

/** 默认轨迹名称：轨迹 11-07 14:32。 */
export function defaultTrackName(ms = Date.now()) {
  return `轨迹 ${formatDateShort(ms)}`;
}

/** 字节数 → 人类可读。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

/**
 * 采样规则的人话描述。
 * @param {{minIntervalSec:number,minDistanceM:number,maxAccuracyM:number}} sample
 */
export function describeSample(sample) {
  const parts = [];
  const hasTime = Number(sample?.minIntervalSec) > 0;
  const hasDistance = Number(sample?.minDistanceM) > 0;

  if (hasTime && hasDistance) {
    parts.push(`每 ${sample.minIntervalSec} 秒且移动 ≥ ${sample.minDistanceM} 米`);
  } else if (hasTime) {
    parts.push(`每 ${sample.minIntervalSec} 秒`);
  } else if (hasDistance) {
    parts.push(`移动 ≥ ${sample.minDistanceM} 米`);
  } else {
    parts.push('每个通过精度检查的定位点');
  }

  if (Number(sample?.maxAccuracyM) > 0) {
    parts.push(`精度 ≤ ${sample.maxAccuracyM} 米`);
  }
  return parts.join(' · ');
}
