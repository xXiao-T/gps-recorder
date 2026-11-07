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
 * 用短暂的 watchPosition 而不是 getCurrentPosition：
 * - watch 可以被 clearWatch 明确取消，不会在超时后留下浏览器内部挂起请求；
 * - 后续“开始记录”的 watch 不会被上一次定位请求堵塞；
 * - 高精度阶段无结果时，可选回退到低精度网络定位。
 *
 * 自己的 JS 定时器保证即使权限弹窗未处理，Promise 也一定结束。
 *
 * @param {{
 *   timeout?: number,
 *   signal?: AbortSignal|null,
 *   fallbackAfter?: number,
 *   onPhase?: ((phase:'high'|'low')=>void)|null
 * }} [options]
 * @returns {Promise<object>}
 */
export function getCurrentFix({
  timeout = 20_000,
  signal = null,
  fallbackAfter = 0,
  onPhase = null,
} = {}) {
  assertSupport();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LocationError('cancelled', '已取消定位'));
      return;
    }

    let settled = false;
    let watchId = null;
    let watchToken = 0;
    let lowPhase = false;
    let overallTimer = null;
    let fallbackTimer = null;

    const cleanup = () => {
      watchToken += 1;
      if (overallTimer !== null) clearTimeout(overallTimer);
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      overallTimer = null;
      fallbackTimer = null;
      if (watchId !== null) {
        try {
          navigator.geolocation.clearWatch(watchId);
        } catch {
          /* ignore */
        }
        watchId = null;
      }
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };

    const onAbort = () => {
      finish(reject, new LocationError('cancelled', '已取消定位'));
    };

    const startWatch = (highAccuracy) => {
      if (settled) return;
      if (watchId !== null) {
        try {
          navigator.geolocation.clearWatch(watchId);
        } catch {
          /* ignore */
        }
        watchId = null;
      }

      const token = ++watchToken;
      try {
        watchId = navigator.geolocation.watchPosition(
          (position) => {
            if (token !== watchToken) return;
            finish(resolve, normalizePosition(position));
          },
          (error) => {
            if (token !== watchToken) return;
            const mapped = mapGeolocationError(error);
            if (
              !lowPhase &&
              fallbackAfter > 0 &&
              (mapped.code === 'timeout' || mapped.code === 'unavailable')
            ) {
              enterLowPhase();
              return;
            }
            finish(reject, mapped);
          },
          {
            enableHighAccuracy: highAccuracy,
            maximumAge: 0,
            timeout: Math.max(5_000, Math.min(15_000, timeout)),
          },
        );
      } catch (error) {
        finish(
          reject,
          new LocationError('unknown', error?.message || '定位请求失败'),
        );
      }
    };

    const enterLowPhase = () => {
      if (settled || lowPhase) return;
      lowPhase = true;
      onPhase?.('low');
      startWatch(false);
    };

    overallTimer = setTimeout(() => {
      finish(
        reject,
        new LocationError(
          'timeout',
          '等待定位超时。请确认浏览器弹窗中选择了“允许”，检查系统定位与“精确位置”权限，或到开阔处重试。',
        ),
      );
    }, timeout);

    if (fallbackAfter > 0 && fallbackAfter < timeout) {
      fallbackTimer = setTimeout(() => {
        if (!settled && !lowPhase) enterLowPhase();
      }, fallbackAfter);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    onPhase?.('high');
    startWatch(true);
  });
}

/**
 * 开始持续监听定位。始终只有一个 watch。
 * @param {{onFix:(fix:object)=>void, onError:(error:LocationError)=>void, enableHighAccuracy?:boolean}} handlers
 */
export function startWatch({ onFix, onError, enableHighAccuracy = true }) {
  assertSupport();
  stopWatch();
  watchId = navigator.geolocation.watchPosition(
    (position) => onFix(normalizePosition(position)),
    (error) => onError(mapGeolocationError(error)),
    {
      enableHighAccuracy: Boolean(enableHighAccuracy),
      maximumAge: 0,
      timeout: 15_000,
    },
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
