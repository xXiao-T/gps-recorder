/**
 * 单点 / 轨迹导出弹层：选择格式与坐标系，分享或下载。
 */

import { CRS_LABELS, EXPORT_FORMATS } from './constants.js';
import { downloadFile, shareOrDownload } from './download.js';
import { buildTrackFile, buildWaypointFile } from './formats.js';
import { loadPrefs } from './prefs.js';
import { listTrackPoints } from './repository.js';
import { createSheet, h, icon, toast } from './ui.js';

/**
 * @param {{kind:'waypoint'|'track', entity:object, points?:object[]|null}} options
 */
export async function openExportDialog({ kind, entity, points = null }) {
  if (!entity) return;
  const isTrack = kind === 'track';
  let trackPoints = points;
  if (isTrack && !trackPoints) {
    try {
      trackPoints = await listTrackPoints(entity.id);
    } catch (error) {
      toast(error.message || '读取轨迹点失败', { type: 'error' });
      return;
    }
  }

  const prefs = await loadPrefs();
  let formatId = 'gpx';
  let crs = prefs.exportCrs === 'gcj02' ? 'gcj02' : 'wgs84';

  const formats = Object.values(EXPORT_FORMATS).filter(
    (format) => !isTrack || !format.waypointOnly,
  );
  const pointCount = isTrack ? trackPoints?.length ?? 0 : 1;

  const sheet = createSheet({
    title: isTrack ? '导出轨迹' : '导出单点',
    description: isTrack
      ? `${entity.name} · ${pointCount} 个点`
      : entity.name || '当前坐标',
  });

  const formatGroup = h('div', {
    class: 'chip-group',
    role: 'radiogroup',
    'aria-label': '导出格式',
  });
  for (const format of formats) {
    const input = h('input', {
      type: 'radio',
      name: 'export-format',
      value: format.id,
      checked: format.id === formatId,
      class: 'sr-only',
    });
    input.addEventListener('change', () => {
      if (input.checked) formatId = format.id;
    });
    formatGroup.append(
      h(
        'label',
        { class: 'chip' },
        input,
        h('span', { class: 'chip-label', text: format.label }),
        h('span', { class: 'chip-sub', text: `.${format.ext}` }),
      ),
    );
  }

  const crsSelect = h(
    'select',
    { class: 'select' },
    h('option', { value: 'wgs84', text: CRS_LABELS.wgs84 }),
    h('option', { value: 'gcj02', text: CRS_LABELS.gcj02 }),
  );
  crsSelect.value = crs;

  const warning = h('p', {
    class: 'warning-box',
    text: '标准 GPX / KML / GeoJSON 约定使用 WGS-84。GCJ-02 仅适合高德系工具，导入其他软件会偏移数百米。',
  });
  const updateWarning = () => {
    warning.classList.toggle('hidden', crs !== 'gcj02');
  };
  crsSelect.addEventListener('change', () => {
    crs = crsSelect.value;
    updateWarning();
  });
  updateWarning();

  const errorEl = h('p', { class: 'form-error', role: 'alert' });

  sheet.body.append(
    h('div', { class: 'form-section' }, h('span', { class: 'field-label', text: '格式' }), formatGroup),
    h(
      'div',
      { class: 'form-section' },
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: '坐标基准' }), crsSelect),
      warning,
    ),
    h('p', {
      class: 'hint',
      text: isTrack
        ? '轨迹按段导出：暂停或信号中断处会分成多段，不会画出穿越空档的假线。'
        : '文件名会自动带上坐标系后缀，避免与其他文件混淆。',
    }),
    errorEl,
  );

  const canShare =
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof File !== 'undefined';

  const downloadButton = h(
    'button',
    { type: 'button', class: 'btn secondary' },
    icon('download'),
    '下载',
  );
  const shareButton = h(
    'button',
    { type: 'button', class: 'btn primary' },
    canShare ? icon('share') : icon('download'),
    canShare ? '分享' : '下载文件',
  );

  const build = () => {
    if (isTrack) {
      if (!trackPoints?.length) throw new Error('轨迹没有可导出的点');
      return buildTrackFile(entity, trackPoints, { format: formatId, crs });
    }
    return buildWaypointFile(entity, { format: formatId, crs });
  };

  const setBusy = (busy) => {
    shareButton.disabled = busy;
    downloadButton.disabled = busy;
    shareButton.classList.toggle('is-busy', busy);
  };

  downloadButton.addEventListener('click', () => {
    setBusy(true);
    errorEl.textContent = '';
    try {
      downloadFile(build());
      toast('已开始下载', { type: 'success' });
      sheet.close();
    } catch (error) {
      errorEl.textContent = error.message || '导出失败';
      setBusy(false);
    }
  });

  shareButton.addEventListener('click', async () => {
    setBusy(true);
    errorEl.textContent = '';
    try {
      const file = build();
      if (!canShare) {
        downloadFile(file);
        toast('当前浏览器不支持分享，已下载文件', { type: 'success' });
        sheet.close();
        return;
      }
      const result = await shareOrDownload(file);
      if (result === 'cancelled') {
        setBusy(false);
        return;
      }
      toast(result === 'shared' ? '已发送分享' : '已下载文件', { type: 'success' });
      sheet.close();
    } catch (error) {
      errorEl.textContent = error.message || '导出失败';
      setBusy(false);
    }
  });

  sheet.footer.append(downloadButton, shareButton);
  return sheet.closed;
}
