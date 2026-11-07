/**
 * 应用入口：数据库检查、Hash 路由、底部导航、全局提示与 Service Worker。
 */

import { openDb } from './db.js';
import { loadPrefs } from './prefs.js';
import { getSnapshot as getRecorderSnapshot } from './recorder.js';
import { applyUpdate, registerServiceWorker } from './sw-register.js';
import { closeAllSheets, h, icon } from './ui.js';
import { mount as mountLocate } from './pages/locate.js';
import { mount as mountRecord } from './pages/record.js';
import { mount as mountSaved } from './pages/saved.js';
import {
  mountTrackDetail,
  mountWaypointDetail,
} from './pages/track-detail.js';
import { mount as mountSettings } from './pages/settings.js';

const appRoot = document.getElementById('app');
const bannerStack = document.getElementById('banner-stack');
const settingsButton = document.getElementById('btn-settings');

const routes = [
  {
    pattern: /^#\/locate\/?$/,
    title: '定位',
    tab: 'locate',
    mount: mountLocate,
  },
  {
    pattern: /^#\/record\/?$/,
    title: '轨迹',
    tab: 'record',
    mount: mountRecord,
  },
  {
    pattern: /^#\/saved\/?$/,
    title: '记录',
    tab: 'saved',
    mount: mountSaved,
  },
  {
    pattern: /^#\/saved\/track\/([^/]+)\/?$/,
    title: '轨迹详情',
    tab: 'saved',
    mount: mountTrackDetail,
    params: (match) => ({ id: decodeURIComponent(match[1]) }),
  },
  {
    pattern: /^#\/saved\/waypoint\/([^/]+)\/?$/,
    title: '单点详情',
    tab: 'saved',
    mount: mountWaypointDetail,
    params: (match) => ({ id: decodeURIComponent(match[1]) }),
  },
  {
    pattern: /^#\/settings\/?$/,
    title: '设置',
    tab: null,
    mount: mountSettings,
  },
];

let currentUnmount = null;
let routeToken = 0;

// ---------------------------------------------------------------------------
// 顶部横幅
// ---------------------------------------------------------------------------

function removeBanner(id) {
  document.getElementById(`banner-${id}`)?.remove();
}

function showBanner({
  id,
  message,
  action = null,
  onAction = null,
  tone = 'info',
  dismissible = false,
}) {
  if (document.getElementById(`banner-${id}`)) return;
  bannerStack.append(
    h(
      'div',
      { id: `banner-${id}`, class: `banner banner-${tone}`, role: 'status' },
      h('span', { class: 'banner-text', text: message }),
      action
        ? h('button', {
            type: 'button',
            class: 'banner-action',
            text: action,
            onclick: onAction,
          })
        : null,
      dismissible
        ? h(
            'button',
            {
              type: 'button',
              class: 'banner-close',
              'aria-label': '关闭提示',
              onclick: () => removeBanner(id),
            },
            icon('close'),
          )
        : null,
    ),
  );
}

function updateOnlineBanner() {
  if (!navigator.onLine) {
    showBanner({
      id: 'offline',
      tone: 'warning',
      message: '离线模式：底图不可用，定位、记录与导出仍可使用。',
    });
  } else {
    removeBanner('offline');
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

function updateActiveTab(tab) {
  for (const link of document.querySelectorAll('[data-tab]')) {
    const active = link.dataset.tab === tab;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function renderFatal(error) {
  appRoot.replaceChildren(
    h(
      'div',
      { class: 'page stack' },
      h(
        'div',
        { class: 'empty-state' },
        h('div', { class: 'empty-icon' }, icon('warning')),
        h('h2', { text: '页面无法启动' }),
        h('p', { class: 'muted', text: error?.message || String(error) }),
        h(
          'button',
          {
            type: 'button',
            class: 'btn secondary',
            onclick: () => location.reload(),
          },
          '重试',
        ),
      ),
    ),
  );
}

async function route() {
  const hash = location.hash || '#/locate';
  const routeConfig = routes.find((candidate) => candidate.pattern.test(hash));

  if (!routeConfig) {
    location.replace('#/locate');
    return;
  }

  const token = ++routeToken;
  closeAllSheets();

  if (currentUnmount) {
    try {
      await currentUnmount();
    } catch (error) {
      console.warn('页面卸载失败', error);
    }
    currentUnmount = null;
  }
  if (token !== routeToken) return;

  appRoot.replaceChildren();
  updateActiveTab(routeConfig.tab);
  document.title = `${routeConfig.title} · 点迹`;
  window.scrollTo(0, 0);

  const match = hash.match(routeConfig.pattern);
  const params = routeConfig.params ? routeConfig.params(match) : {};

  try {
    const cleanup = await routeConfig.mount(appRoot, params);
    if (token !== routeToken) {
      cleanup?.();
      return;
    }
    currentUnmount = typeof cleanup === 'function' ? cleanup : null;
  } catch (error) {
    console.error(error);
    if (token !== routeToken) return;
    renderFatal(error);
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function boot() {
  settingsButton.addEventListener('click', () => {
    if (location.hash !== '#/settings') location.hash = '#/settings';
  });

  window.addEventListener('hashchange', () => void route());
  updateOnlineBanner();
  window.addEventListener('online', updateOnlineBanner);
  window.addEventListener('offline', updateOnlineBanner);

  window.addEventListener('app-map-tile-error', () => {
    showBanner({
      id: 'tile-error',
      tone: 'warning',
      message: '地图瓦片加载失败；定位、记录与导出不受影响。',
      action: '知道了',
      onAction: () => removeBanner('tile-error'),
    });
  });

  window.addEventListener('app-db-versionchange', () => {
    showBanner({
      id: 'db-version',
      tone: 'warning',
      message: '本地数据库已升级，请刷新页面以继续使用。',
      action: '刷新',
      onAction: () => location.reload(),
    });
  });

  window.addEventListener('beforeunload', (event) => {
    const status = getRecorderSnapshot().status;
    if (['acquiring', 'recording', 'paused'].includes(status)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  try {
    await loadPrefs();
    await openDb();
  } catch (error) {
    renderFatal(error);
    return;
  }

  if (!location.hash) {
    history.replaceState(null, '', '#/locate');
  }
  await route();

  registerServiceWorker({
    onUpdate: () => {
      showBanner({
        id: 'update',
        message: '新版本已就绪。若正在记录，请先结束并保存，再刷新页面。',
        action: '刷新',
        onAction: applyUpdate,
        dismissible: true,
      });
    },
  });
}

void boot();
