/**
 * 坐标与距离工具（纯函数，无 DOM 依赖）。
 *
 * 约定：
 * - 业务坐标对象统一为 { lat, lng }，纬度在前，单位十进制度，基准 WGS-84。
 * - GCJ-02 仅在展示/导出适配层使用，绝不写回数据库。
 * - 高德底图为 GCJ-02；WGS-84 与 GCJ-02 在中国大陆相差约数百米。
 */

const PI = Math.PI;
const EARTH_RADIUS_M = 6_371_008.8;

// GCJ-02 算法常量（克拉索夫斯基椭球）
const A = 6_378_245.0;
const EE = 0.006_693_421_622_965_943;

/** 判断经纬度是否为有限且落在合法范围内。 */
export function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

/**
 * 中国境外近似矩形。注意：这不是国界，仅用于跳过 GCJ 偏移；
 * 边界附近可能出现数百米跳变，不可用于法律/边界判断。
 */
export function isOutOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret =
    -100.0 +
    2.0 * x +
    3.0 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret +=
    ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret =
    300.0 +
    x +
    2.0 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret +=
    ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/**
 * WGS-84 → GCJ-02。
 * @param {{lat:number,lng:number}} coord
 * @returns {{lat:number,lng:number}} 新对象，不修改入参
 */
export function wgs84ToGcj02(coord) {
  const { lat, lng } = coord;
  if (!isValidLatLng(lat, lng) || isOutOfChina(lat, lng)) {
    return { lat, lng };
  }

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);

  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);

  return { lat: lat + dLat, lng: lng + dLng };
}

/**
 * GCJ-02 → WGS-84，用不动点迭代反算，往返误差 < 1 cm。
 * @param {{lat:number,lng:number}} coord
 * @returns {{lat:number,lng:number}} 新对象，不修改入参
 */
export function gcj02ToWgs84(coord) {
  const { lat, lng } = coord;
  if (!isValidLatLng(lat, lng) || isOutOfChina(lat, lng)) {
    return { lat, lng };
  }

  let wLat = lat;
  let wLng = lng;
  for (let i = 0; i < 12; i += 1) {
    const guessed = wgs84ToGcj02({ lat: wLat, lng: wLng });
    const dLat = guessed.lat - lat;
    const dLng = guessed.lng - lng;
    wLat -= dLat;
    wLng -= dLng;
    if (Math.abs(dLat) < 1e-12 && Math.abs(dLng) < 1e-12) break;
  }
  return { lat: wLat, lng: wLng };
}

/**
 * 球面距离（haversine），单位米。
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 */
export function haversineM(a, b) {
  const rad = PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const clamped = Math.min(1, Math.max(0, h));
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(clamped));
}

/**
 * 十进制度格式化：固定小数位，消除 "-0.000000"。
 * @param {number} value
 * @param {number} [digits=6]
 */
export function formatDecimal(value, digits = 6) {
  if (!Number.isFinite(value)) return '—';
  let text = value.toFixed(digits);
  if (/^-0(\.0+)?$/.test(text)) text = text.slice(1);
  return text;
}

/**
 * 单个纬度/经度转 DMS：39°54′32.40″N。
 * 处理秒/分四舍五入后的进位。
 * @param {number} value
 * @param {'lat'|'lng'} axis
 */
export function toDms(value, axis) {
  if (!Number.isFinite(value)) return '—';
  const positive = axis === 'lat' ? 'N' : 'E';
  const negative = axis === 'lat' ? 'S' : 'W';
  const hemisphere = value < 0 ? negative : positive;

  const abs = Math.abs(value);
  let degrees = Math.floor(abs);
  const minuteFloat = (abs - degrees) * 60;
  let minutes = Math.floor(minuteFloat);
  let seconds = Math.round((minuteFloat - minutes) * 60 * 100) / 100;

  if (seconds >= 60) {
    seconds -= 60;
    minutes += 1;
  }
  if (minutes >= 60) {
    minutes -= 60;
    degrees += 1;
  }

  return `${degrees}°${String(minutes).padStart(2, '0')}′${seconds
    .toFixed(2)
    .padStart(5, '0')}″${hemisphere}`;
}

/** "39.909000, 116.397000"（纬度, 经度）。 */
export function formatLatLng(coord, digits = 6) {
  return `${formatDecimal(coord.lat, digits)}, ${formatDecimal(coord.lng, digits)}`;
}

/** "39°54′32.40″N, 116°23′49.20″E"（纬度, 经度）。 */
export function formatDmsPair(coord) {
  return `${toDms(coord.lat, 'lat')}, ${toDms(coord.lng, 'lng')}`;
}
