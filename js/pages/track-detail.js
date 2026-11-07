/**
 * 轨迹详情与单点详情页。
 */

import { coordinateList } from '../coordinate-view.js';
import { openExportDialog } from '../export-dialog.js';
import {
  describeSample,
  formatAccuracy,
  formatAverageSpeed,
  formatDateTime,
  formatDateTimeSec,
  formatDistance,
  formatDuration,
  formatSpeed,
} from '../format.js';
import { MapView } from '../map-view.js';
import { loadPrefs } from '../prefs.js';
import { getSnapshot } from '../recorder.js';
import {
  deleteTrack,
  deleteWaypoint,
  getTrack,
  getWaypoint,
  listTrackPoints,
  updateTrackMeta,
  updateWaypoint,
} from '../repository.js';
import { confirmSheet, formDialog, h, icon, toast } from '../ui.js';

function backBar() {
  return h(
    'div',
    { class: 'page-topbar' },
    h('a', { class: 'back-link', href: '#/saved' }, icon('back'), '记录'),
    h('span', { class: 'small muted', text: '详情' }),
  );
}

function notFound(root, message) {
  root.append(
    h(
      'div',
      { class: 'page stack' },
      backBar(),
      h(
        'div',
        { class: 'empty-state' },
        h('div', { class: 'empty-icon' }, icon('warning')),
        h('h2', { text: '找不到记录' }),
        h('p', { class: 'muted', text: message }),
        h('a', { class: 'btn secondary', href: '#/saved', text: '返回记录' }),
      ),
    ),
  );
  return () => {};
}

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

export async function mountTrackDetail(root, params) {
  let destroyed = false;
  let mapView = null;

  let track;
  let points;
  let prefs;
  try {
    track = await getTrack(params.id);
    if (!track) return notFound(root, '轨迹可能已被删除。');
    points = await listTrackPoints(track.id);
    prefs = await loadPrefs();
  } catch (error) {
    return notFound(root, error.message || '读取轨迹失败。');
  }

  const isDraft = track.status === 'draft';
  const isActive = getSnapshot().track?.id === track.id;
  const nameEl = h('h1', { class: 'detail-title', text: track.name });
  const metaEl = h('p', {
    class: 'muted small',
    text: `${formatDateTime(track.startedAt)}${
      track.endedAt ? ` → ${formatDateTime(track.endedAt)}` : ''
    }`,
  });
  const noteEl = h('p', {
    class: `note-text${track.note ? '' : ' muted'}`,
    text: track.note || '无备注',
  });

  const stats = h(
    'div',
    { class: 'stat-grid' },
    statCard('距离', formatDistance(track.stats?.distanceM ?? 0)),
    statCard('时长', formatDuration(track.activeMs ?? 0)),
    statCard(
      '平均速度',
      formatAverageSpeed(track.stats?.distanceM ?? 0, track.activeMs ?? 0),
    ),
    statCard('点数', String(track.stats?.pointCount ?? points.length)),
  );

  const mapEl = h('div', { class: 'map' });
  const mapCard = h('section', { class: 'map-card' }, mapEl);

  const exportButton = h(
    'button',
    {
      type: 'button',
      class: 'btn primary block',
      disabled: isDraft,
      onclick: async () => {
        try {
          await openExportDialog({ kind: 'track', entity: track, points });
        } catch (error) {
          toast(error.message || '导出失败', { type: 'error' });
        }
      },
    },
    icon('download'),
    isDraft ? '草稿不能导出' : '导出 / 分享',
  );

  const editButton = h(
    'button',
    { type: 'button', class: 'btn secondary' },
    icon('edit'),
    '编辑名称与备注',
  );

  const deleteButton = h(
    'button',
    {
      type: 'button',
      class: 'btn danger',
      disabled: isActive,
      title: isActive ? '记录进行中，请先在轨迹页结束记录' : undefined,
      onclick: async () => {
        const ok = await confirmSheet({
          title: isDraft ? '删除草稿' : '删除轨迹',
          message: `删除“${track.name}”及其全部轨迹点？此操作不可撤销。`,
          confirmText: '删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await deleteTrack(track.id);
          toast(isDraft ? '草稿已删除' : '轨迹已删除');
          location.hash = '#/saved';
        } catch (error) {
          toast(error.message || '删除失败', { type: 'error' });
        }
      },
    },
    icon('trash'),
    '删除',
  );

  const actions = h(
    'div',
    { class: 'btn-row stack-actions' },
    isDraft
      ? h('a', { class: 'btn primary block', href: '#/record' }, '去轨迹页继续记录')
      : exportButton,
    editButton,
    deleteButton,
  );

  const page = h(
    'div',
    { class: 'page stack' },
    backBar(),
    mapCard,
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-title-row' },
        nameEl,
        isActive
          ? h('span', { class: 'badge badge-live', text: '记录中' })
          : isDraft
            ? h('span', { class: 'badge badge-warn', text: '草稿' })
            : h('span', { class: 'badge', text: '已完成' }),
      ),
      metaEl,
      stats,
      h('p', {
        class: 'hint',
        text: `采样：${describeSample(track.sample || prefs.sampleDefaults)} · 共 ${points.length} 个点`,
      }),
      noteEl,
    ),
    actions,
  );
  root.append(page);

  editButton.addEventListener('click', async () => {
    const values = await formDialog({
      title: '编辑轨迹',
      fields: [
        { name: 'name', label: '名称', value: track.name, maxlength: 80 },
        {
          name: 'note',
          label: '备注',
          type: 'textarea',
          value: track.note || '',
          maxlength: 1000,
        },
      ],
      submitText: '保存',
    });
    if (!values || destroyed) return;
    try {
      track = await updateTrackMeta(track.id, {
        name: values.name,
        note: values.note,
      });
      nameEl.textContent = track.name;
      noteEl.textContent = track.note || '无备注';
      noteEl.classList.toggle('muted', !track.note);
      toast('已更新', { type: 'success' });
    } catch (error) {
      toast(error.message || '更新失败', { type: 'error' });
    }
  });

  try {
    mapView = new MapView(mapEl, {
      basemap: prefs.basemap,
      center: { lat: 35, lng: 105 },
      zoom: 4,
    });
    if (points.length) {
      mapView.showTrack(points);
    } else {
      mapView.setViewWgs({ lat: 35, lng: 105 }, 4);
    }
  } catch (error) {
    toast(error.message || '地图初始化失败', { type: 'error' });
  }

  return () => {
    destroyed = true;
    mapView?.destroy();
    mapView = null;
  };
}

export async function mountWaypointDetail(root, params) {
  let destroyed = false;
  let mapView = null;

  let waypoint;
  let prefs;
  try {
    waypoint = await getWaypoint(params.id);
    if (!waypoint) return notFound(root, '单点可能已被删除。');
    prefs = await loadPrefs();
  } catch (error) {
    return notFound(root, error.message || '读取单点失败。');
  }

  const nameEl = h('h1', { class: 'detail-title', text: waypoint.name });
  const metaEl = h('p', {
    class: 'muted small',
    text: `${formatDateTime(waypoint.createdAt)} · ${
      waypoint.source === 'map' ? '地图选点' : 'GPS 定位'
    }`,
  });
  const noteEl = h('p', {
    class: `note-text${waypoint.note ? '' : ' muted'}`,
    text: waypoint.note || '无备注',
  });

  const mapEl = h('div', { class: 'map' });
  const mapCard = h('section', { class: 'map-card' }, mapEl);

  const stats = h(
    'div',
    { class: 'stat-grid' },
    statCard('海拔', altitudeText(waypoint.altitudeM)),
    statCard('精度', formatAccuracy(waypoint.accuracyM)),
    statCard('速度', formatSpeed(waypoint.speedMps)),
    statCard(
      '定位时间',
      formatDateTimeSec(waypoint.fixAt ?? waypoint.createdAt),
    ),
  );

  const exportButton = h(
    'button',
    { type: 'button', class: 'btn primary block' },
    icon('download'),
    '导出 / 分享',
  );
  const editButton = h(
    'button',
    { type: 'button', class: 'btn secondary' },
    icon('edit'),
    '编辑名称与备注',
  );
  const deleteButton = h(
    'button',
    {
      type: 'button',
      class: 'btn danger',
      onclick: async () => {
        const ok = await confirmSheet({
          title: '删除单点',
          message: `删除“${waypoint.name}”？此操作不可撤销。`,
          confirmText: '删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await deleteWaypoint(waypoint.id);
          toast('单点已删除');
          location.hash = '#/saved';
        } catch (error) {
          toast(error.message || '删除失败', { type: 'error' });
        }
      },
    },
    icon('trash'),
    '删除',
  );

  const page = h(
    'div',
    { class: 'page stack' },
    backBar(),
    mapCard,
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-title-row' },
        nameEl,
        h('span', {
          class: 'badge',
          text: waypoint.source === 'map' ? '地图选点' : 'GPS',
        }),
      ),
      metaEl,
      coordinateList(waypoint),
      stats,
      noteEl,
    ),
    h('div', { class: 'btn-row stack-actions' }, exportButton, editButton, deleteButton),
  );
  root.append(page);

  exportButton.addEventListener('click', async () => {
    try {
      await openExportDialog({ kind: 'waypoint', entity: waypoint });
    } catch (error) {
      toast(error.message || '导出失败', { type: 'error' });
    }
  });

  editButton.addEventListener('click', async () => {
    const values = await formDialog({
      title: '编辑单点',
      fields: [
        { name: 'name', label: '名称', value: waypoint.name, maxlength: 80 },
        {
          name: 'note',
          label: '备注',
          type: 'textarea',
          value: waypoint.note || '',
          maxlength: 1000,
        },
      ],
      submitText: '保存',
    });
    if (!values || destroyed) return;
    try {
      waypoint = await updateWaypoint(waypoint.id, {
        name: values.name,
        note: values.note,
      });
      nameEl.textContent = waypoint.name;
      noteEl.textContent = waypoint.note || '无备注';
      noteEl.classList.toggle('muted', !waypoint.note);
      toast('已更新', { type: 'success' });
    } catch (error) {
      toast(error.message || '更新失败', { type: 'error' });
    }
  });

  try {
    mapView = new MapView(mapEl, {
      basemap: prefs.basemap,
      center: { lat: waypoint.lat, lng: waypoint.lng },
      zoom: 16,
    });
    mapView.showWaypoint(waypoint);
  } catch (error) {
    toast(error.message || '地图初始化失败', { type: 'error' });
  }

  return () => {
    destroyed = true;
    mapView?.destroy();
    mapView = null;
  };
}
