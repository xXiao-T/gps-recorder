/**
 * 记录页：已保存单点与轨迹列表，支持查看、导出、删除；草稿置顶。
 */

import { openExportDialog } from '../export-dialog.js';
import {
  formatAccuracy,
  formatDateTime,
  formatDistance,
  formatDuration,
} from '../format.js';
import { formatLatLng } from '../geo.js';
import { getSnapshot } from '../recorder.js';
import {
  deleteTrack,
  deleteWaypoint,
  listTracks,
  listWaypoints,
} from '../repository.js';
import { confirmSheet, h, icon, toast } from '../ui.js';

let currentSegment = 'waypoints';

function segmentButton(label, value, count, onClick) {
  return h(
    'button',
    {
      type: 'button',
      class: `segment${currentSegment === value ? ' active' : ''}`,
      'aria-pressed': String(currentSegment === value),
      onclick: onClick,
    },
    h('span', { text: label }),
    h('span', { class: 'segment-count', text: String(count) }),
  );
}

export async function mount(root) {
  let destroyed = false;
  let waypoints = [];
  let tracks = [];

  const listEl = h('div', { class: 'stack' });
  const segmented = h('div', { class: 'segmented', role: 'group', 'aria-label': '记录类型' });
  const page = h(
    'div',
    { class: 'page stack' },
    h(
      'div',
      { class: 'page-head' },
      h('h1', { class: 'page-title', text: '记录' }),
      h('p', { class: 'muted small', text: '单点与轨迹只保存在本机浏览器。' }),
    ),
    segmented,
    listEl,
  );
  root.append(page);

  async function reload() {
    try {
      const [nextWaypoints, nextTracks] = await Promise.all([
        listWaypoints(),
        listTracks(),
      ]);
      if (destroyed) return;
      waypoints = nextWaypoints;
      tracks = nextTracks;
      render();
    } catch (error) {
      toast(error.message || '读取记录失败', { type: 'error' });
    }
  }

  function render() {
    const draftCount = tracks.filter((track) => track.status === 'draft').length;
    segmented.replaceChildren(
      segmentButton('单点', 'waypoints', waypoints.length, () => {
        currentSegment = 'waypoints';
        render();
      }),
      segmentButton('轨迹', 'tracks', tracks.length, () => {
        currentSegment = 'tracks';
        render();
      }),
    );
    listEl.replaceChildren();

    if (currentSegment === 'waypoints') {
      if (!waypoints.length) {
        listEl.append(emptyState('pin', '还没有单点', '定位后点“保存此点”，就会出现在这里。', '去定位', '#/locate'));
        return;
      }
      for (const waypoint of waypoints) {
        listEl.append(waypointCard(waypoint));
      }
      return;
    }

    if (!tracks.length) {
      listEl.append(emptyState('route', '还没有轨迹', '在轨迹页按间隔记录一段线路。', '开始记录', '#/record'));
      return;
    }

    const drafts = tracks.filter((track) => track.status === 'draft');
    const completed = tracks.filter((track) => track.status !== 'draft');
    if (draftCount > 0) {
      listEl.append(
        h('p', {
          class: 'section-label',
          text: `未完成草稿 ${draftCount} 条 · 进入轨迹页继续或保存`,
        }),
      );
    }
    for (const track of [...drafts, ...completed]) {
      listEl.append(trackCard(track));
    }
  }

  function emptyState(iconName, title, message, actionLabel, href) {
    return h(
      'div',
      { class: 'empty-state' },
      h('div', { class: 'empty-icon' }, icon(iconName)),
      h('h2', { text: title }),
      h('p', { class: 'muted', text: message }),
      actionLabel ? h('a', { class: 'btn secondary', href, text: actionLabel }) : null,
    );
  }

  function waypointCard(waypoint) {
    const mainButton = h(
      'button',
      {
        type: 'button',
        class: 'item-main',
        onclick: () => {
          location.hash = `#/saved/waypoint/${encodeURIComponent(waypoint.id)}`;
        },
      },
      h('div', { class: 'item-title', text: waypoint.name }),
      h('div', {
        class: 'item-meta',
        text: `${formatDateTime(waypoint.createdAt)} · ${
          waypoint.source === 'map' ? '地图选点' : 'GPS'
        } · 精度 ${formatAccuracy(waypoint.accuracyM)}`,
      }),
      h('div', { class: 'item-coord mono', text: formatLatLng(waypoint) }),
    );

    const exportButton = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn bordered',
        'aria-label': '导出单点',
        onclick: () => openExportDialog({ kind: 'waypoint', entity: waypoint }),
      },
      icon('download'),
    );
    const deleteButton = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn bordered danger-text',
        'aria-label': '删除单点',
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
            toast('已删除单点');
            await reload();
          } catch (error) {
            toast(error.message || '删除失败', { type: 'error' });
          }
        },
      },
      icon('trash'),
    );

    return h(
      'div',
      { class: 'item-card' },
      mainButton,
      h('div', { class: 'item-actions' }, exportButton, deleteButton),
    );
  }

  function trackCard(track) {
    const isDraft = track.status === 'draft';
    const isActiveDraft = isDraft && getSnapshot().track?.id === track.id;
    const mainButton = h(
      'button',
      {
        type: 'button',
        class: 'item-main',
        onclick: () => {
          location.hash = isDraft
            ? '#/record'
            : `#/saved/track/${encodeURIComponent(track.id)}`;
        },
      },
      h(
        'div',
        { class: 'card-title-row' },
        h('div', { class: 'item-title', text: track.name }),
        isDraft
          ? h('span', {
              class: `badge ${isActiveDraft ? 'badge-live' : 'badge-warn'}`,
              text: isActiveDraft ? '进行中' : '草稿',
            })
          : null,
      ),
      h('div', {
        class: 'item-meta',
        text: `${formatDateTime(track.startedAt)} · ${formatDistance(
          track.stats?.distanceM ?? 0,
        )} · ${formatDuration(track.activeMs ?? 0)} · ${track.stats?.pointCount ?? 0} 点`,
      }),
      h('div', {
        class: 'item-coord mono',
        text: isDraft ? '点击进入轨迹页继续记录' : '点击查看轨迹与导出',
      }),
    );

    const exportButton = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn bordered',
        'aria-label': '导出轨迹',
        disabled: isDraft,
        onclick: async () => {
          try {
            await openExportDialog({ kind: 'track', entity: track });
          } catch (error) {
            toast(error.message || '导出失败', { type: 'error' });
          }
        },
      },
      icon('download'),
    );

    const deleteButton = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn bordered danger-text',
        'aria-label': '删除轨迹',
        disabled: isActiveDraft,
        title: isActiveDraft ? '记录进行中，请先在轨迹页结束记录' : undefined,
        onclick: async () => {
          if (isActiveDraft) return;
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
            await reload();
          } catch (error) {
            toast(error.message || '删除失败', { type: 'error' });
          }
        },
      },
      icon('trash'),
    );

    return h(
      'div',
      { class: `item-card${isDraft ? ' draft-item' : ''}` },
      mainButton,
      h('div', { class: 'item-actions' }, exportButton, deleteButton),
    );
  }

  render();
  await reload();

  return () => {
    destroyed = true;
  };
}
