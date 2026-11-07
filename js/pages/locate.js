/**
 * 定位页：获取当前位置、双坐标系展示与复制、地图选点、保存单点。
 */

import { coordinateList, coordinatePreview } from '../coordinate-view.js';
import { defaultWaypointName, formatAccuracy, formatDateTimeSec, formatSpeed } from '../format.js';
import { getCurrentFix } from '../location.js';
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
    locateButton.disabled = loading;
    locateButton.textContent = loading ? '正在获取定位…' : '获取当前位置';
    locateButton.classList.toggle('is-busy', loading);
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
    setLocating(true);
    setStatus('正在获取定位…');
    try {
      const fix = await getCurrentFix();
      if (destroyed) return;
      currentFix = fix;
      renderFix(fix);
      content.classList.remove('hidden');
      setStatus('');
      if (mapView) {
        mapView.updateCurrent(fix, { follow: true, pan: true });
        mapView.setViewWgs(fix, 16);
      }
      toast('定位成功', { type: 'success' });
    } catch (error) {
      if (!destroyed) {
        setStatus(error.message || '定位失败，请重试', 'error');
        toast(error.message || '定位失败', { type: 'error', duration: 3600 });
      }
    } finally {
      locating = false;
      if (!destroyed) setLocating(false);
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
    if (!mapView || pickMode) return;
    pickMode = true;
    mapCard.classList.add('picking');
    pickOverlay.classList.remove('hidden');
    actionRow.classList.add('hidden');
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
    if (currentFix) content.classList.remove('hidden');
  }

  locateButton.addEventListener('click', locate);
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
    pickButton.disabled = false;
    if (currentFix) mapView.updateCurrent(currentFix);
  } catch (error) {
    setStatus(error.message || '地图初始化失败', 'error');
  }

  return () => {
    destroyed = true;
    pickOff?.();
    pickOff = null;
    mapView?.destroy();
    mapView = null;
  };
}
