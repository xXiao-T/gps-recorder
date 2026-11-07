/**
 * Geolocation 封装：统一字段名、错误映射，并保证同一时间只有一个 watchPosition。
 *
 * 输出的 fix 字段与数据库模型保持一致：
 * { lat, lng, altitudeM, accuracyM, speedMps, headingDeg, timestamp, receivedAt }
 */

export class LocationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocationError';
    this.code = code;
  }
}

let watchId = null;

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePosition(position) {
  const coords = position.coords;
  return {
    lat: coords.latitude,
    lng: coords.longitude,
    altitudeM: finiteOrNull(coords.altitude),
    accuracyM: finiteOrNull(coords.accuracy),
    speedMps: finiteOrNull(coords.speed),
    headingDeg: finiteOrNull(coords.heading),
    timestamp: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
    receivedAt: Date.now(),
  };
}

function mapGeolocationError(error) {
  switch (error?.code) {
    case 1:
      return new LocationError(
        'denied',
        '定位权限被拒绝。请在浏览器地址栏旁的权限设置中允许本站获取位置。',
      );
    case 2:
      return new LocationError(
        'unavailable',
        '暂时无法获取定位信号。请到开阔处重试，并确认已开启精确位置。',
      );
    case 3:
      return new LocationError(
        'timeout',
        '获取定位超时。请确认 GPS 可用后重试。',
      );
    default:
      return new LocationError('unknown', error?.message || '定位失败');
  }
}

/** 检查安全上下文与 API 支持，返回中文错误或 null。 */
export function checkLocationSupport() {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return new LocationError('unsupported', '当前浏览器不支持定位 API。');
  }
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return new LocationError(
      'insecure',
      '定位需要 HTTPS 安全连接。请使用部署后的 HTTPS 地址，或在 localhost 调试。',
    );
  }
  return null;
}

function assertSupport() {
  const error = checkLocationSupport();
  if (error) throw error;
}

/**
 * 查询定位权限状态：granted / prompt / denied / unknown / insecure / unsupported。
 * 部分浏览器不支持 Permissions API 时会返回 unknown，由实际定位请求触发询问。
 */
export async function getGeolocationPermissionState() {
  const support = checkLocationSupport();
  if (support) {
    if (support.code === 'insecure') return 'insecure';
    if (support.code === 'unsupported') return 'unsupported';
  }
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
    return 'unknown';
  }
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 监听定位权限变化；回调会立即触发一次。返回取消监听的函数。
 * @param {(state:string)=>void} callback
 */
export function watchGeolocationPermission(callback) {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
    callback('unknown');
    return () => {};
  }

  let status = null;
  let cancelled = false;
  navigator.permissions
    .query({ name: 'geolocation' })
    .then((result) => {
      if (cancelled) return;
      status = result;
      callback(result.state || 'unknown');
      result.onchange = () => callback(result.state || 'unknown');
    })
    .catch(() => {
      if (!cancelled) callback('unknown');
    });

  return () => {
    cancelled = true;
    if (status) status.onchange = null;
  };
}

/**
 * 获取一次当前位置。
 *
 * 除了传给 Geolocation API 的 timeout，还加了一个自己的 JS 定时器：
 * 当权限弹窗一直未被处理时，某些浏览器不会触发原生 timeout，页面会看起来“卡死”。
 * 自己的定时器保证 Promise 一定结束，让 UI 可以恢复并提示用户检查权限。
 *
 * @param {{timeout?:number}} [options]
 * @returns {Promise<object>}
 */
export function getCurrentFix({ timeout = 20_000 } = {}) {
  assertSupport();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      handler(value);
    };

    timer = setTimeout(() => {
      finish(
        reject,
        new LocationError(
          'timeout',
          '等待定位超时。若浏览器弹出了权限询问，请先选择“允许”；若没有弹窗，请检查本站的定位权限与系统定位开关。',
        ),
      );
    }, timeout);

    navigator.geolocation.getCurrentPosition(
      (position) => finish(resolve, normalizePosition(position)),
      (error) => finish(reject, mapGeolocationError(error)),
      { enableHighAccuracy: true, maximumAge: 0, timeout },
    );
  });
}

/**
 * 开始持续监听定位。始终只有一个 watch。
 * @param {{onFix:(fix:object)=>void, onError:(error:LocationError)=>void}} handlers
 */
export function startWatch({ onFix, onError }) {
  assertSupport();
  stopWatch();
  watchId = navigator.geolocation.watchPosition(
    (position) => onFix(normalizePosition(position)),
    (error) => onError(mapGeolocationError(error)),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
  );
  return watchId;
}

export function stopWatch() {
  if (watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null;
}

export function isWatching() {
  return watchId !== null;
}
