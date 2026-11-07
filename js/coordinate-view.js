/**
 * 坐标系卡片：同时展示 WGS-84 与 GCJ-02，并分别提供十进制/DMS 复制。
 */

import { CRS_SHORT } from './constants.js';
import { formatDmsPair, formatLatLng, wgs84ToGcj02 } from './geo.js';
import { copyAndToast, h, icon } from './ui.js';

function makeCard({ crs, coord, hint }) {
  const label = CRS_SHORT[crs];
  const decimalText = `纬度, 经度: ${formatLatLng(coord)}\n坐标系: ${label}`;
  const dmsText = `DMS: ${formatDmsPair(coord)}\n坐标系: ${label}`;

  return h(
    'div',
    { class: `coord-card coord-${crs}` },
    h(
      'div',
      { class: 'coord-head' },
      h('span', { class: 'badge', text: label }),
      h('span', { class: 'muted small', text: hint }),
    ),
    h('div', { class: 'coord-value mono', text: formatLatLng(coord) }),
    h('div', { class: 'coord-sub mono', text: formatDmsPair(coord) }),
    h(
      'div',
      { class: 'copy-row' },
      h(
        'button',
        {
          type: 'button',
          class: 'chip-btn',
          onclick: () => copyAndToast(decimalText, `${label} 十进制坐标已复制`),
        },
        icon('copy'),
        '复制十进制',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'chip-btn',
          onclick: () => copyAndToast(dmsText, `${label} DMS 坐标已复制`),
        },
        icon('copy'),
        '复制 DMS',
      ),
    ),
  );
}

/** 返回包含两套坐标系的卡片组。 */
export function coordinateList(coord) {
  const gcj = wgs84ToGcj02(coord);
  return h(
    'div',
    { class: 'coord-list' },
    makeCard({ crs: 'wgs84', coord, hint: 'GPS 原始坐标 · 地图按此基准显示' }),
    makeCard({ crs: 'gcj02', coord: gcj, hint: '供高德 App 等国内地图工具使用' }),
  );
}

/** 简短的坐标预览，用于地图选点弹层。 */
export function coordinatePreview(coord) {
  const gcj = wgs84ToGcj02(coord);
  return h(
    'div',
    { class: 'coord-preview' },
    h(
      'div',
      {},
      h('span', { class: 'muted small', text: 'WGS-84' }),
      h('div', { class: 'mono', text: formatLatLng(coord) }),
    ),
    h(
      'div',
      {},
      h('span', { class: 'muted small', text: 'GCJ-02' }),
      h('div', { class: 'mono', text: formatLatLng(gcj) }),
    ),
  );
}
