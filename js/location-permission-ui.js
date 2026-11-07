/**
 * 定位权限相关的用户交互：授权前说明、被拒绝后的开启指引。
 */

import { createSheet, h } from './ui.js';

/** 在真正触发浏览器权限弹窗前，先解释会发生什么。 */
export function showLocationPermissionPrimer({ onContinue } = {}) {
  const sheet = createSheet({
    title: '允许获取位置',
    description: '下一步浏览器会弹出定位权限询问。',
  });

  sheet.body.append(
    h('p', {
      class: 'confirm-message',
      text: '请选择“允许”，并开启“精确位置”。位置只在本机用于记录，不会上传。',
    }),
    h(
      'ol',
      { class: 'permission-steps' },
      h('li', { text: '浏览器弹窗出现后选择“允许”。' }),
      h('li', { text: '如出现“精确 / 大致位置”，请选择“精确”。' }),
      h('li', { text: '如果没有弹窗，请回到页面检查“定位权限”卡片。' }),
    ),
  );

  sheet.footer.append(
    h('button', {
      type: 'button',
      class: 'btn secondary',
      text: '取消',
      onclick: () => sheet.close(false),
    }),
    h('button', {
      type: 'button',
      class: 'btn primary',
      text: '继续，允许定位',
      onclick: () => {
        sheet.close(true);
        onContinue?.();
      },
    }),
  );

  return sheet;
}

/** 权限被拒绝后，给出 Android/Chrome 的开启步骤与重新检测按钮。 */
export function showLocationPermissionHelp({ onCheck } = {}) {
  const sheet = createSheet({
    title: '开启定位权限',
    description: '如果之前点了“拒绝”，Chrome 通常不会再自动弹窗，需要手动开启。',
  });

  sheet.body.append(
    h(
      'ol',
      { class: 'permission-steps' },
      h('li', { text: '确认手机系统定位（GPS）开关已打开。' }),
      h('li', {
        text: 'Chrome 打开本页，点地址栏左侧的锁/调节图标 → 权限 → 位置 → 允许。',
      }),
      h('li', {
        text: '若“点迹”已安装到主屏幕：长按图标 → 应用信息 → 权限 → 位置；或先在 Chrome 中打开本页完成授权。',
      }),
      h('li', {
        text: '系统设置 → 应用 → Chrome → 权限 → 位置 → 允许。',
      }),
      h('li', { text: '回到本页，点下方“我已开启，重新检测”。' }),
    ),
    h('p', {
      class: 'hint',
      text: '不同 Android 厂商的设置入口名称可能略有不同，例如“位置信息”“定位权限”“权限管理”。',
    }),
  );

  sheet.footer.append(
    h('button', {
      type: 'button',
      class: 'btn secondary',
      text: '关闭',
      onclick: () => sheet.close(false),
    }),
    h('button', {
      type: 'button',
      class: 'btn primary',
      text: '我已开启，重新检测',
      onclick: () => {
        sheet.close(true);
        onCheck?.();
      },
    }),
  );

  return sheet;
}
