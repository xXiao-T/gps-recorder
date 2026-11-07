/**
 * 轨迹页：记录控制、间隔采样设置、实时统计与地图、草稿恢复。
 */

import { SAMPLE_LIMITS } from '../constants.js';
import {
  describeSample,
  formatAccuracy,
  formatAverageSpeed,
  formatDateTime,
  formatDistance,
  formatDuration,
} from '../format.js';
import { getGeolocationPermissionState } from '../location.js';
import { showLocationPermissionHelp } from '../location-permission-ui.js';
import { MapView } from '../map-view.js';
import { getCachedPrefs, loadPrefs, savePrefs } from '../prefs.js';
import { getDraft, listTrackPoints, updateTrackMeta } from '../repository.js';
import * as recorder from '../recorder.js';
import { confirmSheet, formDialog, h, icon, toast } from '../ui.js';

const STATUS_TEXT = {
  idle: '未开始',
  acquiring: '等待定位',
  recording: '记录中',
  paused: '已暂停',
  ending: '正在保存',
};

function actionButton(label, { variant = 'primary', disabled = false, onClick, iconName } = {}) {
  return h(
    'button',
    {
      type: 'button',
      class: `btn ${variant}`,
      disabled,
      onclick: onClick,
    },
    iconName ? icon(iconName) : null,
    label,
  );
}

function statCard(label, valueEl) {
  return h(
    'div',
    { class: 'stat' },
    h('span', { class: 'stat-label', text: label }),
    valueEl,
  );
}

export async function mount(root) {
  let destroyed = false;
  let mapView = null;
  let prefs = await loadPrefs();
  let followEnabled = prefs.autoFollow;
  let draft = null;
  let autoResumeAttempted = false;
  let actionBusy = false;
  let controlsKey = '';
  let loadedTrackId = null;
  let loadingTrackId = null;
  let lastRenderedTimestamp = 0;
  let hasCentered = false;
  let lastSnapshot = recorder.getSnapshot();

  const pill = h(
    'span',
    { class: 'pill pill-idle' },
    h('span', { class: 'pill-dot' }),
    h('span', { id: 'record-status', text: '未开始' }),
  );
  const wakeLabel = h('span', { class: 'small muted wake-label' });
  const heroDistance = h('div', { class: 'hero-distance', text: '0 m' });
  const heroSub = h('div', { class: 'hero-sub', text: '准备好后，点下方开始记录' });

  const statDuration = h('strong', { class: 'stat-value', text: '00:00' });
  const statPoints = h('strong', { class: 'stat-value', text: '0' });
  const statAverage = h('strong', { class: 'stat-value', text: '—' });
  const statAccuracy = h('strong', { class: 'stat-value', text: '—' });
  const statsGrid = h(
    'div',
    { class: 'stat-grid' },
    statCard('用时', statDuration),
    statCard('点数', statPoints),
    statCard('平均速度', statAverage),
    statCard('当前精度', statAccuracy),
  );

  const sampleSummary = h('p', { class: 'sample-summary' });
  const controls = h('div', { class: 'btn-row record-controls' });
  const alerts = h('div', { class: 'stack' });
  const draftSlot = h('div', { class: 'stack' });
  const completedSlot = h('div', { class: 'stack' });

  const hero = h(
    'section',
    { class: 'card record-hero' },
    h('div', { class: 'record-top' }, pill, wakeLabel),
    heroDistance,
    heroSub,
    statsGrid,
    sampleSummary,
    controls,
    h('p', {
      class: 'hint',
      text: '记录时请保持页面在前台；Android 后台或锁屏可能暂停定位。每个点都会立即保存。',
    }),
  );

  const mapEl = h('div', { class: 'map' });
  const recenterButton = h(
    'button',
    { type: 'button', class: 'map-float-btn hidden' },
    '居中',
  );
  const mapCard = h('section', { class: 'map-card' }, mapEl, recenterButton);

  const page = h(
    'div',
    { class: 'page stack' },
    hero,
    alerts,
    mapCard,
    draftSlot,
    completedSlot,
  );
  root.append(page);

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  function updateTimeStats(s) {
    heroDistance.textContent = s.pointCount ? formatDistance(s.distanceM) : '0 m';
    statDuration.textContent = formatDuration(s.activeMs);
    statPoints.textContent = String(s.pointCount);
    statAverage.textContent = formatAverageSpeed(s.distanceM, s.activeMs);
    statAccuracy.textContent = formatAccuracy(s.latestFix?.accuracyM);
  }

  function wakeText(s) {
    if (s.status !== 'acquiring' && s.status !== 'recording') return '';
    if (!s.keepAwake) return '屏幕常亮关闭';
    switch (s.wakeLock) {
      case 'active':
        return '屏幕常亮已开启';
      case 'unsupported':
        return '浏览器不支持屏幕常亮';
      case 'error':
        return '屏幕常亮开启失败';
      case 'released':
        return '屏幕常亮已释放';
      default:
        return '';
    }
  }

  function renderStatus(s) {
    pill.className = `pill pill-${s.status}`;
    pill.lastChild.textContent = STATUS_TEXT[s.status] || s.status;
    wakeLabel.textContent = wakeText(s);
    statAccuracy.textContent = formatAccuracy(s.latestFix?.accuracyM);

    switch (s.status) {
      case 'acquiring':
        heroSub.textContent = '正在等待 GPS 信号，首个有效点会自动开始记录…';
        break;
      case 'recording':
        heroSub.textContent = '正在记录，轨迹点会立即保存到本机。';
        break;
      case 'paused':
        heroSub.textContent = '已暂停，已记录的点安全保存在本机。';
        break;
      case 'ending':
        heroSub.textContent = '正在保存轨迹…';
        break;
      default:
        heroSub.textContent = s.lastCompleted
          ? '上一条轨迹已保存。'
          : '准备好后，点下方开始记录';
        break;
    }

    sampleSummary.textContent = describeSample(
      s.sample || getCachedPrefs().sampleDefaults,
    );
    updateRecenterVisibility(s);
  }

  function renderControls(s, force = false) {
    const key = `${s.status}|${actionBusy}|${Boolean(s.track)}`;
    if (!force && key === controlsKey) return;
    controlsKey = key;
    controls.replaceChildren();

    const pauseAction = async () => {
      try {
        await recorder.pause();
      } catch (error) {
        toast(error.message || '暂停失败', { type: 'error' });
      }
    };

    const resumeAction = async () => {
      try {
        await recorder.resume();
      } catch (error) {
        toast(error.message || '继续失败', { type: 'error' });
      }
    };

    const stopAction = async () => {
      if (actionBusy) return;
      const confirmed = await confirmSheet({
        title: '结束记录',
        message: '结束并保存当前轨迹？已记录的点会完整保留。',
        confirmText: '结束并保存',
        danger: true,
      });
      if (!confirmed || destroyed) return;

      actionBusy = true;
      renderControls(recorder.getSnapshot(), true);
      try {
        const completed = await recorder.stop();
        if (completed) {
          toast('轨迹已保存', { type: 'success' });
          void openSummary(completed);
        } else {
          toast('没有记录到有效点，未生成轨迹', { type: 'info' });
        }
      } catch (error) {
        toast(error.message || '结束失败', { type: 'error' });
      } finally {
        actionBusy = false;
        if (!destroyed) {
          renderControls(recorder.getSnapshot(), true);
          await loadDraft();
        }
      }
    };

    switch (s.status) {
      case 'acquiring':
        controls.append(
          actionButton(s.track ? '暂停' : '取消', {
            variant: 'secondary block',
            disabled: actionBusy,
            onClick: pauseAction,
          }),
        );
        break;
      case 'recording':
        controls.append(
          actionButton('暂停', {
            variant: 'secondary',
            disabled: actionBusy,
            onClick: pauseAction,
          }),
          actionButton('结束', {
            variant: 'danger',
            disabled: actionBusy,
            onClick: stopAction,
          }),
        );
        break;
      case 'paused':
        controls.append(
          actionButton('继续记录', {
            variant: 'primary',
            disabled: actionBusy,
            onClick: resumeAction,
          }),
          actionButton('结束', {
            variant: 'danger',
            disabled: actionBusy,
            onClick: stopAction,
          }),
        );
        break;
      case 'ending':
        controls.append(
          actionButton('正在保存…', {
            variant: 'secondary block',
            disabled: true,
          }),
        );
        break;
      default:
        controls.append(
          actionButton('开始记录', {
            variant: 'primary block',
            disabled: actionBusy,
            onClick: onStart,
          }),
        );
        break;
    }
  }

  function renderAlerts(s) {
    alerts.replaceChildren();
    if (!s.error) return;

    const isStorage = s.error.code === 'storage';
    const canRetry =
      !isStorage &&
      ['acquiring', 'recording', 'paused'].includes(s.status);
    const canOpenPermissionHelp = ['denied', 'no-fix'].includes(s.error.code);
    const canTryLowAccuracy =
      !s.track && !s.lowAccuracy && s.error.code === 'no-fix';

    const retryButton = canRetry
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn small secondary',
            onclick: () => recorder.retry(),
          },
          '重试定位',
        )
      : null;

    const lowAccuracyButton = canTryLowAccuracy
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn small secondary',
            onclick: () => {
              recorder.retry({ lowAccuracy: true });
              toast('已切换到室内低精度模式，等待定位…', { type: 'info' });
            },
          },
          '低精度重试',
        )
      : null;

    const permissionHelpButton = canOpenPermissionHelp
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn small secondary',
            onclick: () => {
              showLocationPermissionHelp({
                onCheck: async () => {
                  const state = await getGeolocationPermissionState();
                  if (state === 'granted') {
                    toast('定位权限已开启，重试定位…', { type: 'success' });
                    void recorder.retry();
                  } else {
                    toast('仍未检测到定位权限，请按说明开启', {
                      type: 'error',
                      duration: 4000,
                    });
                  }
                },
              });
            },
          },
          '开启定位权限',
        )
      : null;

    alerts.append(
      h(
        'div',
        { class: 'alert-card', role: 'alert' },
        icon('warning'),
        h(
          'div',
          { class: 'alert-body' },
          h('strong', { text: isStorage ? '本地保存异常' : '定位异常' }),
          h('p', { text: s.error.message }),
          isStorage
            ? h('p', {
                class: 'hint',
                text: '请检查浏览器存储空间；已有轨迹可在“记录”页查看和导出。',
              })
            : null,
          canRetry || canOpenPermissionHelp || canTryLowAccuracy
            ? h(
                'div',
                { class: 'btn-row compact' },
                permissionHelpButton,
                lowAccuracyButton,
                retryButton,
              )
            : null,
        ),
      ),
    );
  }

  function renderDraftSlot(s) {
    draftSlot.replaceChildren();
    if (s.status !== 'idle' || !draft) return;

    const continueButton = actionButton('继续记录', {
      variant: 'primary small',
      onClick: async () => {
        try {
          await recorder.recoverAndResume(draft);
          draft = null;
          renderDraftSlot(recorder.getSnapshot());
          toast('已恢复草稿，等待定位…');
        } catch (error) {
          toast(error.message || '恢复失败', { type: 'error' });
        }
      },
    });
    const finishButton = actionButton('结束保存', {
      variant: 'secondary small',
      onClick: async () => {
        try {
          const completed = await recorder.finishDraft(draft);
          draft = null;
          renderDraftSlot(recorder.getSnapshot());
          await openSummary(completed);
        } catch (error) {
          toast(error.message || '保存失败', { type: 'error' });
        }
      },
    });
    const deleteButton = actionButton('删除', {
      variant: 'danger small',
      onClick: async () => {
        const ok = await confirmSheet({
          title: '删除草稿',
          message: '删除后无法恢复，确定丢弃这条未完成轨迹吗？',
          confirmText: '删除草稿',
          danger: true,
        });
        if (!ok) return;
        try {
          await recorder.discardDraft(draft.id);
          draft = null;
          renderDraftSlot(recorder.getSnapshot());
          toast('草稿已删除');
        } catch (error) {
          toast(error.message || '删除失败', { type: 'error' });
        }
      },
    });

    draftSlot.append(
      h(
        'div',
        { class: 'card draft-card' },
        h(
          'div',
          { class: 'card-title-row' },
          h('strong', { text: '发现未完成轨迹' }),
          h('span', { class: 'badge badge-warn', text: '草稿' }),
        ),
        h('div', { class: 'item-title', text: draft.name }),
        h('p', {
          class: 'muted small',
          text: `${formatDateTime(draft.startedAt)} · ${draft.stats?.pointCount ?? 0} 个点 · ${formatDistance(
            draft.stats?.distanceM ?? 0,
          )}`,
        }),
        h('div', { class: 'btn-row compact' }, continueButton, finishButton, deleteButton),
      ),
    );
  }

  function renderCompletedSlot(s) {
    completedSlot.replaceChildren();
    if (s.status !== 'idle' || !s.lastCompleted) return;
    const track = s.lastCompleted;
    completedSlot.append(
      h(
        'div',
        { class: 'card completed-card' },
        h(
          'div',
          { class: 'card-title-row' },
          h('strong', { text: '上次轨迹已保存' }),
          h('span', { class: 'badge', text: '已完成' }),
        ),
        h('div', { class: 'item-title', text: track.name }),
        h('p', {
          class: 'muted small',
          text: `${formatDistance(track.stats?.distanceM ?? 0)} · ${formatDuration(
            track.activeMs ?? 0,
          )} · ${track.stats?.pointCount ?? 0} 个点`,
        }),
        h(
          'div',
          { class: 'btn-row compact' },
          actionButton('查看详情', {
            variant: 'secondary small',
            onClick: () => {
              location.hash = `#/saved/track/${encodeURIComponent(track.id)}`;
            },
          }),
          actionButton('忽略', {
            variant: 'ghost small',
            onClick: () => recorder.clearCompleted(),
          }),
        ),
      ),
    );
  }

  function render(s) {
    lastSnapshot = s;
    updateTimeStats(s);
    renderStatus(s);
    renderControls(s);
    renderAlerts(s);
    renderDraftSlot(s);
    renderCompletedSlot(s);
  }

  // -------------------------------------------------------------------------
  // 地图
  // -------------------------------------------------------------------------

  function updateRecenterVisibility(s = lastSnapshot) {
    const show =
      !followEnabled &&
      Boolean(s.latestFix) &&
      ['acquiring', 'recording', 'paused'].includes(s.status);
    recenterButton.classList.toggle('hidden', !show);
  }

  async function loadLiveTrack(trackId) {
    if (loadingTrackId === trackId) return;
    loadingTrackId = trackId;
    try {
      const points = await listTrackPoints(trackId);
      if (destroyed || !mapView) return;
      if (recorder.getSnapshot().track?.id !== trackId) return;
      mapView.startLiveTrack(points);
      loadedTrackId = trackId;
      lastRenderedTimestamp = points.length
        ? points[points.length - 1].timestamp
        : 0;

      const current = recorder.getSnapshot();
      if (current.latestFix) {
        mapView.updateCurrent(current.latestFix, { follow: false, pan: false });
      }
      if (!hasCentered && points.length) {
        if (followEnabled && current.latestFix) {
          mapView.setViewWgs(current.latestFix, 16);
        } else {
          mapView.fitToPoints(points);
        }
        hasCentered = true;
      }

      // 读取期间可能又写入了新点，重读一次保证不丢
      if (current.track?.id === trackId && current.pointCount > points.length) {
        loadingTrackId = null;
        void loadLiveTrack(trackId);
      }
    } catch (error) {
      toast(error.message || '加载轨迹点失败', { type: 'error' });
    } finally {
      if (loadingTrackId === trackId) loadingTrackId = null;
    }
  }

  function syncMap(s) {
    if (!mapView) return;

    if (s.latestFix) {
      const active = s.status === 'acquiring' || s.status === 'recording';
      mapView.updateCurrent(s.latestFix, {
        follow: followEnabled && active,
        pan: true,
      });
    }

    if (s.track) {
      if (s.track.id !== loadedTrackId) {
        void loadLiveTrack(s.track.id);
      } else if (
        s.lastAccepted &&
        s.lastAccepted.timestamp > lastRenderedTimestamp
      ) {
        mapView.appendLivePoint(s.lastAccepted, s.lastAccepted.segment);
        lastRenderedTimestamp = s.lastAccepted.timestamp;
      }
    } else if (loadedTrackId) {
      loadedTrackId = null;
      loadingTrackId = null;
      lastRenderedTimestamp = 0;
      hasCentered = false;
    }

    updateRecenterVisibility(s);
  }

  // -------------------------------------------------------------------------
  // 操作
  // -------------------------------------------------------------------------

  async function openStartSheet() {
    const defaults = getCachedPrefs().sampleDefaults;
    const values = await formDialog({
      title: '开始记录',
      description: '时间与距离条件同时满足时才取点；0 表示关闭该条件。',
      fields: [
        {
          name: 'minIntervalSec',
          label: '时间间隔（秒）',
          type: 'number',
          value: defaults.minIntervalSec,
          min: SAMPLE_LIMITS.minIntervalSec.min,
          max: SAMPLE_LIMITS.minIntervalSec.max,
          step: 1,
          inputmode: 'decimal',
          required: true,
        },
        {
          name: 'minDistanceM',
          label: '最小移动距离（米）',
          type: 'number',
          value: defaults.minDistanceM,
          min: SAMPLE_LIMITS.minDistanceM.min,
          max: SAMPLE_LIMITS.minDistanceM.max,
          step: 1,
          inputmode: 'decimal',
          required: true,
        },
        {
          name: 'maxAccuracyM',
          label: '精度阈值（米）',
          type: 'number',
          value: defaults.maxAccuracyM,
          min: SAMPLE_LIMITS.maxAccuracyM.min,
          max: SAMPLE_LIMITS.maxAccuracyM.max,
          step: 1,
          inputmode: 'decimal',
          help: '精度差于此值的定位点会被丢弃；0 表示不限制。',
          required: true,
        },
        {
          name: 'lowAccuracy',
          label: '室内低精度模式',
          type: 'checkbox',
          value: false,
          help: '使用 Wi-Fi/基站定位，延迟更高、精度较低；本次记录不限制精度阈值。',
        },
      ],
      validate: (formValues) => {
        for (const key of ['minIntervalSec', 'minDistanceM', 'maxAccuracyM']) {
          const value = formValues[key];
          if (value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) {
            return '请输入有效的非负数字';
          }
        }
        return null;
      },
      extra: h('p', {
        class: 'hint',
        text: '暂停或 GPS 信号中断后会分成新段，统计和导出不会跨段连线。',
      }),
      submitText: '开始记录',
    });
    if (!values) return;

    const lowAccuracy = Boolean(values.lowAccuracy);
    const sampleDefaults = {
      minIntervalSec: Number(values.minIntervalSec),
      minDistanceM: Number(values.minDistanceM),
      maxAccuracyM: Number(values.maxAccuracyM),
    };
    const sample = {
      ...sampleDefaults,
      // 室内模式下若保留 30 米阈值，Wi-Fi/基站定位几乎都会被丢弃
      maxAccuracyM: lowAccuracy ? 0 : sampleDefaults.maxAccuracyM,
    };

    actionBusy = true;
    renderControls(recorder.getSnapshot(), true);
    try {
      await recorder.start(sample, { lowAccuracy });
      try {
        await savePrefs({ sampleDefaults });
      } catch {
        /* 默认值保存失败不影响本次记录 */
      }
      loadedTrackId = null;
      loadingTrackId = null;
      lastRenderedTimestamp = 0;
      hasCentered = false;
      mapView?.startLiveTrack([]);
      mapView?.clearCurrent();
      toast(
        lowAccuracy
          ? '已开始（室内低精度模式），等待定位…'
          : '已开始，等待定位…',
      );
    } catch (error) {
      toast(error.message || '无法开始记录', { type: 'error' });
    } finally {
      actionBusy = false;
      if (!destroyed) renderControls(recorder.getSnapshot(), true);
    }
  }

  async function onStart() {
    if (actionBusy) return;
    try {
      const existing = await getDraft();
      if (existing) {
        draft = existing;
        renderDraftSlot(recorder.getSnapshot());
        toast('请先处理未完成的轨迹草稿', { type: 'error' });
        draftSlot.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    } catch (error) {
      toast(error.message || '检查草稿失败', { type: 'error' });
      return;
    }
    await openStartSheet();
  }

  async function openSummary(track) {
    if (!track) return;
    const values = await formDialog({
      title: '轨迹已保存',
      description: `${formatDistance(track.stats?.distanceM ?? 0)} · ${formatDuration(
        track.activeMs ?? 0,
      )} · ${track.stats?.pointCount ?? 0} 个点`,
      fields: [
        {
          name: 'name',
          label: '名称',
          value: track.name,
          maxlength: 80,
        },
        {
          name: 'note',
          label: '备注',
          type: 'textarea',
          value: track.note || '',
          maxlength: 1000,
        },
      ],
      submitText: '保存并查看',
      cancelText: '稍后再说',
    });
    if (!values || destroyed) return;
    try {
      await updateTrackMeta(track.id, { name: values.name, note: values.note });
      recorder.clearCompleted();
      location.hash = `#/saved/track/${encodeURIComponent(track.id)}`;
    } catch (error) {
      toast(error.message || '保存名称失败', { type: 'error' });
    }
  }

  async function loadDraft() {
    if (lastSnapshot.status !== 'idle') {
      draft = null;
      renderDraftSlot(lastSnapshot);
      return;
    }

    let found = null;
    try {
      found = await getDraft();
    } catch {
      found = null;
    }
    if (destroyed) return;

    // 页面/App 被刷新或回收后：若草稿上次处于“记录中”且足够新，权限也已允许，
    // 自动恢复记录；暂停中的草稿仍要求用户手动继续。
    if (
      found &&
      !autoResumeAttempted &&
      Number.isFinite(found.segmentStartedAt) &&
      Date.now() - (found.updatedAt || 0) < 10 * 60 * 1000
    ) {
      autoResumeAttempted = true;
      const permission = await getGeolocationPermissionState();
      if (destroyed) return;
      if (permission === 'granted') {
        try {
          await recorder.recoverAndResume(found);
          if (!destroyed) {
            draft = null;
            renderDraftSlot(recorder.getSnapshot());
            toast('已自动恢复记录中的轨迹', { type: 'success' });
            return;
          }
        } catch (error) {
          toast(error.message || '自动恢复失败，请手动继续', {
            type: 'error',
          });
        }
      }
    }

    draft = found;
    if (!destroyed) renderDraftSlot(recorder.getSnapshot());
  }

  // -------------------------------------------------------------------------
  // 初始化与清理
  // -------------------------------------------------------------------------

  try {
    mapView = new MapView(mapEl, {
      basemap: getCachedPrefs().basemap,
      center: { lat: 35, lng: 105 },
      zoom: 4,
    });
    mapView.onUserPan(() => {
      followEnabled = false;
      updateRecenterVisibility(recorder.getSnapshot());
    });
  } catch (error) {
    toast(error.message || '地图初始化失败', { type: 'error' });
  }

  recenterButton.addEventListener('click', () => {
    const s = recorder.getSnapshot();
    followEnabled = true;
    if (mapView && s.latestFix) mapView.setViewWgs(s.latestFix, 16);
    updateRecenterVisibility(s);
  });

  const unsubscribe = recorder.subscribe((s) => {
    if (destroyed) return;
    render(s);
    syncMap(s);
  });

  const timer = setInterval(() => {
    if (destroyed) return;
    updateTimeStats(recorder.getSnapshot());
  }, 1000);

  await loadDraft();

  return () => {
    destroyed = true;
    unsubscribe?.();
    clearInterval(timer);
    mapView?.destroy();
    mapView = null;
  };
}
