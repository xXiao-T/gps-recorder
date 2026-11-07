/**
 * 定位页：获取当前位置、双坐标系展示与复制、地图选点、保存单点。
 */

import { coordinateList, coordinatePreview } from '../coordinate-view.js';
import { defaultWaypointName, formatAccuracy, formatDateTimeSec, formatSpeed } from '../format.js';
import {
  getCurrentFix,
  getGeolocationPermissionState,
  watchGeolocationPermission,
} from '../location.js';
import {
  showLocationPermissionHelp,
  showLocationPermissionPrimer,
} from '../location-permission-ui.js';
import { MapView } from '../map-view.js';
import { loadPrefs } from '../prefs.js';
import { addWaypoint } from '../repository.js';
import { formDialog, h, toast } from '../ui.js';

function statCard(label, value) {
  return h(
    'div',
    { class: 'stat' },
    h('span', { class: 'stat-label', text: label }),
    h('strong', { class: 'stat-value', text: value }),
  );
}

function altitudeText(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} m` : '—';
}

export async function mount(root) {
  let destroyed = false;
  let mapView = null;
  let currentFix = null;
  let pickMode = false;
  let pickCoord = null;
  let pickOff = null;
  let locating = false;
  let locateRequest = 0;
  let locateAbort = null;
  let mapReady = false;
  let permissionState = 'unknown';
  let permissionUnwatch = null;

  const mapEl = h('div', { class: 'map' });
  const pickOverlay = h(
    'div',
    { class: 'pick-overlay hidden' },
    h('div', { class: 'pick-hint', text: '拖动地图，让中心准星对准目标' }),
    h('div', { class: 'pick-crosshair' }),
  );
  const mapCard = h('section', { class: 'map-card' }, mapEl, pickOverlay);

  const statusBox = h('div', { class: 'status-box hidden', role: 'status' });

  const locateButton = h(
    'button',
    { type: 'button', class: 'btn primary block' },
    '获取当前位置',
  );
  const pickButton = h(
    'button',
    { type: 'button', class: 'btn secondary', disabled: true },
    '地图选点',
  );
  const actionRow = h('div', { class: 'btn-row' }, locateButton, pickButton);

  const permissionBadge = h('span', { class: 'badge', text: '检查中…' });
  const permissionText = h('p', {
    class: 'muted small',
    text: '正在检查定位权限…',
  });
  const permissionButton = h('button', {
    type: 'button',
    class: 'btn secondary small hidden',
  });
  let permissionAction = null;
  permissionButton.addEventListener('click', () => permissionAction?.());
  const permissionCard = h(
    'div',
    { class: 'permission-card' },
    h(
      'div',
      { class: 'permission-copy' },
      h(
        'div',
        { class: 'permission-head' },
        h('strong', { text: '定位权限' }),
        permissionBadge,
      ),
      permissionText,
    ),
    permissionButton,
  );

  const coordHost = h('div', {});
  const metaGrid = h('div', { class: 'stat-grid' });
  const saveButton = h(
    'button',
    { type: 'button', class: 'btn primary block' },
    '保存此点',
  );
  const content = h(
    'div',
    { class: 'stack hidden' },
    coordHost,
    metaGrid,
    saveButton,
    h('p', {
      class: 'hint',
      text: '数据只保存在本机浏览器。导出时可选择 WGS-84 或 GCJ-02。',
    }),
  );

  const pickReadout = h('div', { class: 'card coord-preview-card' });
  const pickCancel = h(
    'button',
    { type: 'button', class: 'btn secondary' },
    '取消选点',
  );
  const pickConfirm = h(
    'button',
    { type: 'button', class: 'btn primary' },
    '保存此位置',
  );
  const pickPanel = h(
    'div',
    { class: 'stack hidden' },
    pickReadout,
    h('p', {
      class: 'hint',
      text: '高德栅格瓦片在本应用中按 WGS-84 对齐，保存的就是所选位置的原始坐标。',
    }),
    h('div', { class: 'btn-row' }, pickCancel, pickConfirm),
  );

  const page = h(
    'div',
    { class: 'page stack' },
    mapCard,
    actionRow,
    permissionCard,
    statusBox,
    content,
    pickPanel,
  );
  root.append(page);

  function setStatus(message, type = 'info') {
    statusBox.className = `status-box${message ? '' : ' hidden'} status-${type}`;
    statusBox.textContent = message || '';
  }

  function setLocating(loading) {
    // 等待定位时按钮变成“取消等待”，始终可点，避免权限弹窗未处理时页面看起来卡死。
    locateButton.disabled = false;
    locateButton.textContent = loading
      ? '取消等待'
      : currentFix
        ? '重新获取位置'
        : '获取当前位置';
    locateButton.classList.toggle('cancel-mode', loading);
    pickButton.disabled = !mapReady || loading;
  }

  function updatePermission(state) {
    permissionState = state;
    renderPermission();
  }

  function renderPermission() {
    permissionBadge.className = 'badge';
    permissionButton.classList.add('hidden');
    permissionAction = null;

    switch (permissionState) {
      case 'granted':
        permissionBadge.classList.add('badge-ok');
        permissionBadge.textContent = '已允许';
        permissionText.textContent =
          '浏览器已允许本站访问位置。若系统定位关闭，仍可能获取失败。';
        break;
      case 'prompt':
        permissionBadge.classList.add('badge-warn');
        permissionBadge.textContent = '未授权';
        permissionText.textContent =
          '还没有选择定位权限。点“请求权限”后，请在浏览器弹窗中选择“允许”。';
        permissionButton.textContent = '请求权限';
        permissionButton.classList.remove('hidden');
        permissionAction = showPrimer;
        break;
      case 'denied':
        permissionBadge.classList.add('badge-danger');
        permissionBadge.textContent = '已拒绝';
        permissionText.textContent =
          '定位权限被拒绝。需要在浏览器或系统设置中手动开启。';
        permissionButton.textContent = '开启方法';
        permissionButton.classList.remove('hidden');
        permissionAction = showHelp;
        break;
      case 'insecure':
        permissionBadge.classList.add('badge-warn');
        permissionBadge.textContent = '不可用';
        permissionText.textContent = '定位需要 HTTPS 安全连接，当前页面无法请求位置。';
        break;
      case 'unsupported':
        permissionBadge.classList.add('badge-warn');
        permissionBadge.textContent = '不可用';
        permissionText.textContent = '当前浏览器不支持定位 API，请换用 Chrome。';
        break;
      default:
        permissionBadge.classList.add('badge-warn');
        permissionBadge.textContent = '未知';
        permissionText.textContent =
          '无法读取权限状态；点“请求权限”后由浏览器询问。';
        permissionButton.textContent = '请求权限';
        permissionButton.classList.remove('hidden');
        permissionAction = showPrimer;
        break;
    }
  }

  function showPrimer() {
    showLocationPermissionPrimer({
      onContinue: () => {
        void locate();
      },
    });
  }

  function showHelp() {
    showLocationPermissionHelp({
      onCheck: async () => {
        const state = await getGeolocationPermissionState();
        if (destroyed) return;
        updatePermission(state);
        if (state === 'granted') {
          toast('定位权限已开启，正在获取位置…', { type: 'success' });
          void locate();
        } else if (state === 'prompt') {
          toast('权限还没有选择，请再试一次', { type: 'info' });
          showPrimer();
        } else {
          toast('仍未检测到定位权限，请按步骤检查', {
            type: 'error',
            duration: 4000,
          });
        }
      },
    });
  }

  async function refreshPermission() {
    const state = await getGeolocationPermissionState();
    if (!destroyed) updatePermission(state);
  }

  function handleLocateClick() {
    if (locating) {
      cancelLocate();
      return;
    }
    if (permissionState === 'denied') {
      showHelp();
      return;
    }
    if (permissionState === 'insecure' || permissionState === 'unsupported') {
      const message = permissionText.textContent || '当前环境无法定位';
      setStatus(message, 'error');
      toast(message, { type: 'error', duration: 4000 });
      return;
    }
    if (permissionState === 'prompt' || permissionState === 'unknown') {
      showPrimer();
      return;
    }
    void locate();
  }

  function cancelLocate() {
    if (!locating) return;
    locateRequest += 1;
    locateAbort?.abort();
    locateAbort = null;
    locating = false;
    setLocating(false);
    setStatus(
      '已取消等待。确认浏览器/系统允许定位后，再点“获取当前位置”重试。',
      'info',
    );
    void refreshPermission();
  }

  function renderFix(fix) {
    coordHost.replaceChildren(coordinateList(fix));
    metaGrid.replaceChildren(
      statCard('精度', formatAccuracy(fix.accuracyM)),
      statCard('海拔', altitudeText(fix.altitudeM)),
      statCard('速度', formatSpeed(fix.speedMps)),
      statCard('GPS 时间', formatDateTimeSec(fix.timestamp)),
    );
  }

  async function locate() {
    if (locating) return;
    locating = true;
    const token = ++locateRequest;
    const controller = new AbortController();
    locateAbort = controller;
    setLocating(true);
    setStatus(
      '正在获取定位… 若浏览器弹出权限询问，请选择“允许”。',
      'info',
    );

    try {
      const fix = await getCurrentFix({
        signal: controller.signal,
        // 已授权时高精度 8 秒没有结果，允许自动尝试一次低精度网络定位
        fallbackAfter: permissionState === 'granted' ? 8_000 : 0,
        onPhase: (phase) => {
          if (destroyed || token !== locateRequest) return;
          if (phase === 'low') {
            setStatus(
              '高精度定位暂时没有结果，正在尝试低精度定位…',
              'info',
            );
          }
        },
      });
      if (destroyed || token !== locateRequest) return;
      currentFix = fix;
      renderFix(fix);
      content.classList.remove('hidden');
      updatePermission('granted');
      if (
        Number.isFinite(fix.accuracyM) &&
        fix.accuracyM > 100
      ) {
        setStatus(
          `已获取低精度位置（±${Math.round(
            fix.accuracyM,
          )} m）。建议到开阔处，并确认站点权限为“精确位置”。`,
          'info',
        );
      } else {
        setStatus('');
      }
      if (mapView) {
        mapView.updateCurrent(fix, { follow: true, pan: true });
        mapView.setViewWgs(fix, 16);
      }
      toast('定位成功', { type: 'success' });
    } catch (error) {
      if (destroyed || token !== locateRequest) return;
      if (error.code === 'cancelled' || error.name === 'AbortError') return;

      if (error.code === 'denied') {
        updatePermission('denied');
      } else if (error.code === 'insecure' || error.code === 'unsupported') {
        updatePermission(error.code);
      } else {
        void refreshPermission();
      }

      if (error.code === 'timeout') {
        setStatus(
          '等待定位超时。请确认浏览器弹窗中选择了“允许”，检查系统定位和“精确位置”权限，或到开阔处重试。',
          'error',
        );
      } else {
        setStatus(error.message || '定位失败，请重试', 'error');
      }
      toast(error.message || '定位失败', { type: 'error', duration: 3600 });
    } finally {
      if (locateAbort === controller) locateAbort = null;
      if (token === locateRequest) {
        locating = false;
        if (!destroyed) setLocating(false);
      }
    }
  }

  async function openSaveDialog(fix, source) {
    if (!fix) return;
    const data = await formDialog({
      title: source === 'map' ? '保存地图选点' : '保存此点',
      description:
        source === 'map'
          ? '地图按 WGS-84 对齐，保存所选位置的原始坐标。'
          : '名称和备注只保存在本机。',
      fields: [
        {
          name: 'name',
          label: '名称',
          value: defaultWaypointName(Date.now()),
          maxlength: 80,
          placeholder: '例如：停车场 P4',
        },
        {
          name: 'note',
          label: '备注',
          type: 'textarea',
          maxlength: 1000,
          placeholder: '可选，例如：水点向北 50 米',
        },
      ],
      extra: coordinatePreview(fix),
      submitText: '保存',
    });
    if (!data || destroyed) return;

    try {
      const waypoint = await addWaypoint({
        name: data.name,
        note: data.note,
        lat: fix.lat,
        lng: fix.lng,
        altitudeM: source === 'map' ? null : fix.altitudeM,
        accuracyM: source === 'map' ? null : fix.accuracyM,
        speedMps: source === 'map' ? null : fix.speedMps,
        headingDeg: source === 'map' ? null : fix.headingDeg,
        fixAt: source === 'map' ? null : fix.timestamp,
        source,
      });
      toast('已保存单点', { type: 'success' });
      if (source === 'map') {
        exitPick();
        mapView?.showWaypoint(waypoint);
      }
    } catch (error) {
      toast(error.message || '保存失败', { type: 'error' });
    }
  }

  function renderPickReadout(coord) {
    pickCoord = coord;
    pickReadout.replaceChildren(
      h('div', { class: 'card-title', text: '准星所在位置' }),
      coordinatePreview(coord),
    );
  }

  function enterPick() {
    if (!mapView || pickMode || locating) return;
    pickMode = true;
    mapCard.classList.add('picking');
    pickOverlay.classList.remove('hidden');
    actionRow.classList.add('hidden');
    permissionCard.classList.add('hidden');
    content.classList.add('hidden');
    pickPanel.classList.remove('hidden');
    setStatus('');
    if (currentFix) mapView.setViewWgs(currentFix, 16);
    pickOff = mapView.beginPick((coord) => renderPickReadout(coord));
  }

  function exitPick() {
    if (!pickMode) return;
    pickMode = false;
    pickOff?.();
    pickOff = null;
    mapCard.classList.remove('picking');
    pickOverlay.classList.add('hidden');
    pickPanel.classList.add('hidden');
    actionRow.classList.remove('hidden');
    permissionCard.classList.remove('hidden');
    if (currentFix) content.classList.remove('hidden');
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') void refreshPermission();
  }

  locateButton.addEventListener('click', handleLocateClick);
  saveButton.addEventListener('click', () => openSaveDialog(currentFix, 'gps'));
  pickButton.addEventListener('click', enterPick);
  pickCancel.addEventListener('click', exitPick);
  pickConfirm.addEventListener('click', () => {
    // 以点击瞬间的地图中心为准，避免惯性滑动时读到过期的 moveend 结果
    const coord = mapView?.getCenterWgs() ?? pickCoord;
    if (!coord) {
      toast('请先拖动地图选择位置', { type: 'error' });
      return;
    }
    openSaveDialog(
      { ...coord, altitudeM: null, accuracyM: null, speedMps: null, headingDeg: null },
      'map',
    );
  });

  permissionUnwatch = watchGeolocationPermission((state) => {
    if (!destroyed) updatePermission(state);
  });
  document.addEventListener('visibilitychange', onVisibilityChange);
  renderPermission();

  try {
    const prefs = await loadPrefs();
    if (destroyed) {
      return () => {};
    }
    mapView = new MapView(mapEl, {
      basemap: prefs.basemap,
      center: { lat: 35, lng: 105 },
      zoom: 4,
    });
    mapReady = true;
    setLocating(locating);
    if (currentFix) mapView.updateCurrent(currentFix);
  } catch (error) {
    setStatus(error.message || '地图初始化失败', 'error');
  }

  return () => {
    destroyed = true;
    locateRequest += 1;
    locateAbort?.abort();
    locateAbort = null;
    permissionUnwatch?.();
    permissionUnwatch = null;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    pickOff?.();
    pickOff = null;
    mapView?.destroy();
    mapView = null;
  };
}
