/**
 * 全局常量：应用信息、数据库配置、默认设置、高德瓦片与导出格式。
 * 本模块不访问 DOM / IndexedDB，可被 Node 测试安全导入。
 */

export const APP_NAME = '点迹';
export const APP_VERSION = '1.0.2';

export const DB_NAME = 'gps-recorder-db';
export const DB_VERSION = 1;
export const SETTINGS_KEY = 'preferences';

/** 设置默认值；prefs.js 会在此基础上做范围校验与合并。 */
export const DEFAULT_PREFS = Object.freeze({
  exportCrs: 'wgs84',
  sampleDefaults: Object.freeze({
    minIntervalSec: 5,
    minDistanceM: 3,
    maxAccuracyM: 30,
  }),
  keepAwake: true,
  autoFollow: true,
  basemap: 'vector',
});

/** 采样参数合法范围（单位：秒 / 米）。0 表示关闭该条件。 */
export const SAMPLE_LIMITS = Object.freeze({
  minIntervalSec: Object.freeze({ min: 0, max: 600 }),
  minDistanceM: Object.freeze({ min: 0, max: 5000 }),
  maxAccuracyM: Object.freeze({ min: 0, max: 1000 }),
});

/**
 * 高德栅格瓦片（非官方接口，无需 Key）。
 * - z18 为原生最大级别，z19 由 Leaflet 放大，避免请求无内容的 z19 瓦片。
 * - {s} 由 Leaflet 的 subdomains 1-4 替换。
 */
export const AMAP_TILES = Object.freeze({
  vector:
    'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
  satellite:
    'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
});

export const AMAP_ATTRIBUTION = '© 高德地图 (AMap) · 非官方瓦片';
export const AMAP_SUBDOMAINS = Object.freeze(['1', '2', '3', '4']);

export const CRS_LABELS = Object.freeze({
  wgs84: 'WGS-84（GPS 原始）',
  gcj02: 'GCJ-02（高德）',
});

export const CRS_SHORT = Object.freeze({
  wgs84: 'WGS-84',
  gcj02: 'GCJ-02',
});

/** 导出格式注册表。waypointOnly 表示该格式仅支持单点。 */
export const EXPORT_FORMATS = Object.freeze({
  gpx: Object.freeze({
    id: 'gpx',
    label: 'GPX',
    ext: 'gpx',
    mime: 'application/gpx+xml',
  }),
  kml: Object.freeze({
    id: 'kml',
    label: 'KML',
    ext: 'kml',
    mime: 'application/vnd.google-earth.kml+xml',
  }),
  geojson: Object.freeze({
    id: 'geojson',
    label: 'GeoJSON',
    ext: 'geojson',
    mime: 'application/geo+json',
  }),
  csv: Object.freeze({
    id: 'csv',
    label: 'CSV',
    ext: 'csv',
    mime: 'text/csv;charset=utf-8',
  }),
  txt: Object.freeze({
    id: 'txt',
    label: '文本',
    ext: 'txt',
    mime: 'text/plain;charset=utf-8',
    waypointOnly: true,
  }),
});

/** 原始定位中断的基础判定阈值（毫秒）。 */
export const GPS_GAP_BASE_MS = 30_000;
