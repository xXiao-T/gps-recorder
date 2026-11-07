/**
 * 点迹 Service Worker
 *
 * 策略：
 * - 预缓存应用外壳（HTML/CSS/JS/manifest/图标/Leaflet），保证离线可打开。
 * - 导航请求返回缓存中的 index.html；更新只在用户确认后切换。
 * - 高德瓦片与任何跨域请求完全不拦截、不缓存（离线时底图不可用是明确限制）。
 * - 修改应用版本时同步更新 CACHE 名称。
 */

const APP_VERSION = '1.0.2';
const CACHE_PREFIX = 'gps-recorder-shell-';
const CACHE = `${CACHE_PREFIX}v${APP_VERSION}-r1`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/backup.js',
  './js/constants.js',
  './js/coordinate-view.js',
  './js/db.js',
  './js/download.js',
  './js/export-dialog.js',
  './js/format.js',
  './js/formats.js',
  './js/geo.js',
  './js/location.js',
  './js/location-permission-ui.js',
  './js/map-view.js',
  './js/prefs.js',
  './js/recorder.js',
  './js/repository.js',
  './js/sampling.js',
  './js/sw-register.js',
  './js/ui.js',
  './js/pages/locate.js',
  './js/pages/record.js',
  './js/pages/saved.js',
  './js/pages/settings.js',
  './js/pages/track-detail.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/LICENSE',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(APP_SHELL);
      // 不在这里 skipWaiting：等待用户确认更新，避免记录写库期间切换版本。
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 跨域（高德瓦片等）完全不拦截
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match('./index.html');
        return cached || fetch(request);
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      return fetch(request);
    })(),
  );
});
