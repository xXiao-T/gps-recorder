/**
 * Service Worker 注册与更新流：
 * - 首次安装不提示；
 * - 已有旧版本时，新版本安装在 waiting 状态，由用户确认后刷新；
 * - 不自动 skipWaiting，避免记录写库过程中切换版本。
 */

let registration = null;
let onUpdateHandler = null;
let applyingUpdate = false;
let controllerListenerAdded = false;

function notifyUpdate() {
  if (!registration?.waiting) return;
  onUpdateHandler?.(registration);
}

export async function registerServiceWorker({ onUpdate = null } = {}) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  onUpdateHandler = onUpdate;

  try {
    registration = await navigator.serviceWorker.register(
      new URL('../sw.js', import.meta.url),
    );

    if (navigator.serviceWorker.controller && registration.waiting) {
      notifyUpdate();
    }

    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          notifyUpdate();
        }
      });
    });

    if (!controllerListenerAdded) {
      controllerListenerAdded = true;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (applyingUpdate) window.location.reload();
      });
    }

    setInterval(() => {
      if (document.visibilityState === 'visible') {
        registration?.update().catch(() => {});
      }
    }, 60 * 60 * 1000);

    return registration;
  } catch (error) {
    console.warn('Service Worker 注册失败', error);
    return null;
  }
}

/** 手动检查更新；发现 waiting 版本时返回 true 并触发更新提示。 */
export async function checkForUpdate() {
  if (!registration) return false;
  try {
    await registration.update();
  } catch {
    /* 离线时忽略 */
  }
  if (registration.waiting) {
    if (navigator.serviceWorker.controller) notifyUpdate();
    return true;
  }
  return false;
}

/** 应用更新；新 SW 激活后 controllerchange 会刷新一次页面。 */
export function applyUpdate() {
  if (!registration?.waiting) return;
  applyingUpdate = true;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
}
