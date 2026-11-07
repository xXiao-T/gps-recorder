/**
 * 设置页：采样默认值、地图与导出偏好、本地数据备份恢复、隐私说明。
 */

import {
  APP_NAME,
  APP_VERSION,
  AMAP_ATTRIBUTION,
  CRS_LABELS,
  SAMPLE_LIMITS,
} from '../constants.js';
import {
  buildBackupFilename,
  createBackup,
  restoreBackup,
} from '../backup.js';
import { downloadJson } from '../download.js';
import { formatBytes } from '../format.js';
import { loadPrefs, savePrefs } from '../prefs.js';
import { getSnapshot, setKeepAwake } from '../recorder.js';
import { clearUserData, getDataCounts } from '../repository.js';
import { checkForUpdate } from '../sw-register.js';
import { confirmSheet, h, icon, toast } from '../ui.js';

const MAX_RESTORE_BYTES = 50 * 1024 * 1024;

function settingRow(title, help, control) {
  return h(
    'div',
    { class: 'setting-row' },
    h(
      'div',
      { class: 'setting-copy' },
      h('strong', { text: title }),
      help ? h('span', { class: 'field-help', text: help }) : null,
    ),
    control,
  );
}

function toggle(checked) {
  return h(
    'label',
    { class: 'switch' },
    h('input', { type: 'checkbox', checked }),
    h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
  );
}

export async function mount(root) {
  let prefs = await loadPrefs({ force: true });
  let counts = { waypoints: 0, tracks: 0, points: 0, drafts: 0 };

  try {
    counts = await getDataCounts();
  } catch {
    /* 下方展示为 0 */
  }

  const topbar = h(
    'div',
    { class: 'page-topbar' },
    h('a', { class: 'back-link', href: '#/locate' }, icon('back'), '返回'),
    h('span', { class: 'small muted', text: '设置' }),
  );

  // -------------------------------------------------------------------------
  // 采样默认值
  // -------------------------------------------------------------------------

  const intervalInput = h('input', {
    type: 'number',
    value: prefs.sampleDefaults.minIntervalSec,
    min: SAMPLE_LIMITS.minIntervalSec.min,
    max: SAMPLE_LIMITS.minIntervalSec.max,
    step: 1,
    inputmode: 'decimal',
    required: true,
  });
  const distanceInput = h('input', {
    type: 'number',
    value: prefs.sampleDefaults.minDistanceM,
    min: SAMPLE_LIMITS.minDistanceM.min,
    max: SAMPLE_LIMITS.minDistanceM.max,
    step: 1,
    inputmode: 'decimal',
    required: true,
  });
  const accuracyInput = h('input', {
    type: 'number',
    value: prefs.sampleDefaults.maxAccuracyM,
    min: SAMPLE_LIMITS.maxAccuracyM.min,
    max: SAMPLE_LIMITS.maxAccuracyM.max,
    step: 1,
    inputmode: 'decimal',
    required: true,
  });

  const sampleForm = h(
    'form',
    { class: 'stack' },
    h(
      'div',
      { class: 'form-grid' },
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label', text: '时间间隔（秒）' }),
        intervalInput,
      ),
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label', text: '最小移动距离（米）' }),
        distanceInput,
      ),
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-label', text: '精度阈值（米）' }),
        accuracyInput,
      ),
    ),
    h('p', {
      class: 'hint',
      text: '时间与距离同时满足才会记录；任意一项填 0 表示关闭该条件。修改只影响下一次记录。',
    }),
    h('button', { type: 'submit', class: 'btn secondary', text: '保存采样默认值' }),
  );

  sampleForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = {
      minIntervalSec: Number(intervalInput.value),
      minDistanceM: Number(distanceInput.value),
      maxAccuracyM: Number(accuracyInput.value),
    };
    for (const [key, limits] of Object.entries(SAMPLE_LIMITS)) {
      const value = values[key];
      if (!Number.isFinite(value) || value < limits.min || value > limits.max) {
        toast(
          `请输入 ${limits.min}–${limits.max} 之间的数字`,
          { type: 'error' },
        );
        return;
      }
    }
    try {
      prefs = await savePrefs({ sampleDefaults: values });
      toast('采样默认值已保存', { type: 'success' });
    } catch (error) {
      toast(error.message || '保存失败', { type: 'error' });
    }
  });

  // -------------------------------------------------------------------------
  // 地图与导出
  // -------------------------------------------------------------------------

  const crsSelect = h(
    'select',
    { class: 'select' },
    h('option', { value: 'wgs84', text: CRS_LABELS.wgs84 }),
    h('option', { value: 'gcj02', text: CRS_LABELS.gcj02 }),
  );
  crsSelect.value = prefs.exportCrs;
  crsSelect.addEventListener('change', async () => {
    try {
      prefs = await savePrefs({ exportCrs: crsSelect.value });
      toast('导出坐标基准已保存', { type: 'success' });
    } catch (error) {
      toast(error.message || '保存失败', { type: 'error' });
    }
  });

  const basemapSelect = h(
    'select',
    { class: 'select' },
    h('option', { value: 'vector', text: '矢量路网' }),
    h('option', { value: 'satellite', text: '卫星影像' }),
  );
  basemapSelect.value = prefs.basemap;
  basemapSelect.addEventListener('change', async () => {
    try {
      prefs = await savePrefs({ basemap: basemapSelect.value });
      toast('底图偏好已保存，重新进入地图页生效', { type: 'success' });
    } catch (error) {
      toast(error.message || '保存失败', { type: 'error' });
    }
  });

  const keepAwakeToggle = toggle(prefs.keepAwake);
  keepAwakeToggle.querySelector('input').addEventListener('change', async (event) => {
    const enabled = event.target.checked;
    try {
      prefs = await savePrefs({ keepAwake: enabled });
      if (getSnapshot().track) await setKeepAwake(enabled);
      toast(enabled ? '记录时将保持屏幕常亮' : '已关闭屏幕常亮');
    } catch (error) {
      toast(error.message || '保存失败', { type: 'error' });
    }
  });

  const autoFollowToggle = toggle(prefs.autoFollow);
  autoFollowToggle.querySelector('input').addEventListener('change', async (event) => {
    try {
      prefs = await savePrefs({ autoFollow: event.target.checked });
      toast('地图跟随偏好已保存，重新进入地图页生效');
    } catch (error) {
      toast(error.message || '保存失败', { type: 'error' });
    }
  });

  // -------------------------------------------------------------------------
  // 数据与备份
  // -------------------------------------------------------------------------

  const countsEl = h('p', { class: 'data-counts' });
  const storageEl = h('span', { class: 'mono small', text: '读取中…' });
  const persistEl = h('span', { class: 'small muted', text: '检查中…' });
  const persistButton = h('button', {
    type: 'button',
    class: 'btn secondary small',
    text: '申请持久存储',
  });
  const backupButton = h(
    'button',
    { type: 'button', class: 'btn secondary' },
    icon('download'),
    '导出 JSON 备份',
  );
  const restoreInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    class: 'sr-only',
  });
  const restoreButton = h(
    'button',
    { type: 'button', class: 'btn secondary' },
    icon('refresh'),
    '从备份恢复',
  );
  const clearButton = h(
    'button',
    { type: 'button', class: 'btn danger' },
    icon('trash'),
    '清除全部数据',
  );

  function renderCounts() {
    countsEl.textContent = `单点 ${counts.waypoints} 个 · 轨迹 ${counts.tracks} 条${
      counts.drafts ? `（含草稿 ${counts.drafts}）` : ''
    } · 轨迹点 ${counts.points} 个`;
  }
  renderCounts();

  async function refreshStorage() {
    if (!navigator.storage?.estimate) {
      storageEl.textContent = '浏览器不支持存储用量查询';
      persistEl.textContent = '不支持持久存储 API';
      persistButton.disabled = true;
      return;
    }
    try {
      const estimate = await navigator.storage.estimate();
      storageEl.textContent = `${formatBytes(estimate.usage || 0)} / ${formatBytes(
        estimate.quota || 0,
      )}`;

      if (navigator.storage.persisted) {
        const persisted = await navigator.storage.persisted();
        persistEl.textContent = persisted ? '已启用，浏览器不会轻易清除' : '未启用';
        persistButton.disabled = persisted;
      } else {
        persistEl.textContent = '当前浏览器不支持查询';
        persistButton.disabled = true;
      }
    } catch {
      storageEl.textContent = '读取失败';
      persistEl.textContent = '—';
    }
  }
  await refreshStorage();

  persistButton.addEventListener('click', async () => {
    if (!navigator.storage?.persist) return;
    try {
      const granted = await navigator.storage.persist();
      toast(
        granted ? '已获得持久存储' : '浏览器暂未授予持久存储，可稍后再试',
        { type: granted ? 'success' : 'info', duration: 3600 },
      );
      await refreshStorage();
    } catch (error) {
      toast(error.message || '申请失败', { type: 'error' });
    }
  });

  backupButton.addEventListener('click', async () => {
    backupButton.disabled = true;
    try {
      const data = await createBackup();
      downloadJson(data, buildBackupFilename());
      toast('备份已开始下载', { type: 'success' });
    } catch (error) {
      toast(error.message || '备份失败', { type: 'error' });
    } finally {
      backupButton.disabled = false;
    }
  });

  restoreButton.addEventListener('click', () => {
    const snapshot = getSnapshot();
    if (snapshot.track || snapshot.status !== 'idle') {
      toast('请先在轨迹页结束当前记录，再恢复备份', { type: 'error' });
      return;
    }
    restoreInput.click();
  });

  restoreInput.addEventListener('change', async () => {
    const file = restoreInput.files?.[0];
    restoreInput.value = '';
    if (!file) return;
    if (file.size > MAX_RESTORE_BYTES) {
      toast('备份文件超过 50 MB，已拒绝导入', { type: 'error', duration: 3600 });
      return;
    }

    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast('文件不是有效的 JSON', { type: 'error' });
      return;
    }

    const summary = `备份包含 ${data.waypoints?.length ?? 0} 个单点、${
      data.tracks?.length ?? 0
    } 条轨迹、${data.trackPoints?.length ?? 0} 个轨迹点。`;
    const ok = await confirmSheet({
      title: '从备份恢复',
      message: `${summary}\n恢复会替换当前全部单点、轨迹和设置，确定继续？`,
      confirmText: '覆盖并恢复',
      danger: true,
    });
    if (!ok) return;

    try {
      const result = await restoreBackup(data);
      toast(
        `已恢复 ${result.waypoints} 个单点、${result.tracks} 条轨迹，即将刷新`,
        { type: 'success', duration: 2400 },
      );
      setTimeout(() => location.reload(), 700);
    } catch (error) {
      toast(error.message || '恢复失败', { type: 'error', duration: 5000 });
    }
  });

  clearButton.addEventListener('click', async () => {
    const snapshot = getSnapshot();
    if (snapshot.track || snapshot.status !== 'idle') {
      toast('请先在轨迹页结束当前记录，再清除数据', { type: 'error' });
      return;
    }
    const ok = await confirmSheet({
      title: '清除全部数据',
      message:
        '将永久删除本机所有单点、轨迹和轨迹点。建议先导出 JSON 备份；设置会保留。此操作不可撤销。',
      confirmText: '清除全部数据',
      danger: true,
    });
    if (!ok) return;
    try {
      await clearUserData();
      counts = { waypoints: 0, tracks: 0, points: 0, drafts: 0 };
      renderCounts();
      await refreshStorage();
      toast('本机数据已清除', { type: 'success' });
    } catch (error) {
      toast(error.message || '清除失败', { type: 'error' });
    }
  });

  // -------------------------------------------------------------------------
  // 关于
  // -------------------------------------------------------------------------

  const updateButton = h('button', {
    type: 'button',
    class: 'btn secondary small',
    text: '检查更新',
  });
  updateButton.addEventListener('click', async () => {
    updateButton.disabled = true;
    try {
      const waiting = await checkForUpdate();
      toast(waiting ? '发现新版本，请按页面顶部提示刷新' : '已是最新版本');
    } finally {
      updateButton.disabled = false;
    }
  });

  // -------------------------------------------------------------------------
  // 页面组装
  // -------------------------------------------------------------------------

  const page = h(
    'div',
    { class: 'page stack' },
    topbar,
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'section-title', text: '轨迹采样' }),
      sampleForm,
    ),
    h(
      'section',
      { class: 'card stack' },
      h('h2', { class: 'section-title', text: '地图与导出' }),
      settingRow(
        '导出坐标基准',
        'GPX/KML/GeoJSON 标准使用 WGS-84；GCJ-02 仅适合高德系工具。',
        crsSelect,
      ),
      settingRow('底图', '矢量路网或卫星影像，重新进入地图页生效。', basemapSelect),
      settingRow(
        '记录时保持屏幕常亮',
        '使用 Screen Wake Lock；部分浏览器可能拒绝。',
        keepAwakeToggle,
      ),
      settingRow(
        '地图自动跟随',
        '关闭后在你拖动地图时不会自动回中。',
        autoFollowToggle,
      ),
    ),
    h(
      'section',
      { class: 'card stack' },
      h('h2', { class: 'section-title', text: '本地数据' }),
      h(
        'div',
        { class: 'data-summary' },
        countsEl,
        h(
          'div',
          { class: 'storage-line' },
          h('span', { class: 'small muted', text: '浏览器占用' }),
          storageEl,
        ),
        h(
          'div',
          { class: 'storage-line' },
          h('span', { class: 'small muted', text: '持久存储' }),
          persistEl,
        ),
      ),
      h('p', {
        class: 'hint',
        text: '数据只保存在当前浏览器的 IndexedDB。清除站点数据、卸载 PWA 或更换设备都不会自动同步，请定期导出备份。',
      }),
      h(
        'div',
        { class: 'btn-row' },
        backupButton,
        restoreButton,
        persistButton,
        restoreInput,
        clearButton,
      ),
    ),
    h(
      'section',
      { class: 'card stack' },
      h('h2', { class: 'section-title', text: '关于与隐私' }),
      h('p', {
        class: 'about-line',
        text: `${APP_NAME} · GPS 经纬记录 · v${APP_VERSION}`,
      }),
      h('p', {
        class: 'muted small',
        text: '没有账号、后端和统计脚本；单点、轨迹与设置不上传。唯一的外部请求是高德底图瓦片，会向高德暴露你的 IP 与地图视野范围。',
      }),
      h('p', {
        class: 'muted small',
        text: `底图署名：${AMAP_ATTRIBUTION}。瓦片为非官方接口，可能失效或受高德条款约束，仅供个人使用。`,
      }),
      h('p', {
        class: 'muted small',
        text: '标准 GPX/KML/GeoJSON 约定使用 WGS-84；导出 GCJ-02 后请仅在高德系工具中使用。',
      }),
      h(
        'div',
        { class: 'btn-row' },
        updateButton,
        h('a', {
          class: 'btn ghost small',
          href: './vendor/leaflet/LICENSE',
          target: '_blank',
          rel: 'noopener',
          text: 'Leaflet 许可证',
        }),
      ),
    ),
  );
  root.append(page);

  return () => {};
}
