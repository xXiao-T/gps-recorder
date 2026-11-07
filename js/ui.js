/**
 * 轻量 UI 工具：DOM 构造、toast、复制、底部弹层与表单弹层。
 * 所有用户文本通过 textContent 写入，避免 XSS。
 */

const ICON_PATHS = {
  close:
    '<path d="M6 6l12 12M18 6L6 18"/>',
  copy:
    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download:
    '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  share:
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4"/>',
  trash:
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  edit:
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  back:
    '<path d="M15 18l-6-6 6-6"/>',
  pin:
    '<path d="M12 21s7-6.6 7-12a7 7 0 1 0-14 0c0 5.4 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  route:
    '<path d="M4 18l4-4 3 2 5-7 4 2"/><circle cx="4" cy="18" r="1.6"/><circle cx="20" cy="11" r="1.6"/>',
  check:
    '<path d="M20 6L9 17l-5-5"/>',
  warning:
    '<path d="M12 3L2 21h20L12 3z"/><path d="M12 9v5M12 17.5v.5"/>',
  refresh:
    '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
};

let sheetCounter = 0;
let toastTimer = null;

/** 创建 DOM 节点；字符串子节点一律作为文本插入。 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      el.className = String(value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'html') {
      el.innerHTML = String(value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in el) {
      try {
        el[key] = value;
      } catch {
        el.setAttribute(key, String(value));
      }
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }

  const append = (child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(append);
      return;
    }
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  append(children);
  return el;
}

/** 内联线性图标（静态 SVG，不含用户内容）。 */
export function icon(name) {
  const span = h('span', { class: 'icon', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ''}</svg>`;
  return span;
}

/** 轻提示。 */
export function toast(message, { type = 'info', duration = 2600 } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, duration);
}

/** 复制文本；优先 Clipboard API，失败时回退 execCommand。 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续尝试回退方案 */
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 复制并提示结果。 */
export async function copyAndToast(text, successMessage = '已复制') {
  const ok = await copyText(text);
  toast(ok ? successMessage : '复制失败，请长按或手动选择文本', {
    type: ok ? 'success' : 'error',
  });
}

/**
 * 创建底部弹层。
 * @param {{title?:string, description?:string}} [options]
 * @returns {{dialog:HTMLDialogElement, body:HTMLElement, footer:HTMLElement, close:(value?:unknown)=>void, closed:Promise<unknown>}}
 */
export function createSheet({ title = '', description = '' } = {}) {
  sheetCounter += 1;
  const titleId = `sheet-title-${sheetCounter}`;
  const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': titleId });
  const panel = h('div', { class: 'sheet-panel' });
  const body = h('div', { class: 'sheet-body' });
  const footer = h('div', { class: 'sheet-actions' });

  let resolveClosed;
  let settled = false;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const settle = (value) => {
    if (settled) return;
    settled = true;
    resolveClosed(value);
  };

  const close = (value = null) => {
    settle(value);
    if (dialog.open) {
      dialog.close();
    } else {
      dialog.remove();
    }
  };

  const header = h(
    'div',
    { class: 'sheet-header' },
    h(
      'div',
      { class: 'sheet-heading' },
      h('h2', { id: titleId, text: title }),
      description ? h('p', { class: 'sheet-desc', text: description }) : null,
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': '关闭',
        onclick: () => close(null),
      },
      icon('close'),
    ),
  );

  panel.append(header, body, footer);
  dialog.append(panel);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close(null);
  });
  dialog.addEventListener('close', () => {
    settle(null);
    dialog.remove();
  });

  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, footer, close, closed };
}

function fieldControl(field) {
  const shared = {
    name: field.name,
    required: field.required,
    readonly: field.readonly,
    autocomplete: 'off',
  };

  if (field.type === 'textarea') {
    const el = h('textarea', {
      ...shared,
      rows: field.rows || 3,
      placeholder: field.placeholder,
      maxlength: field.maxlength,
      value: field.value ?? '',
    });
    return el;
  }
  if (field.type === 'select') {
    return h(
      'select',
      { ...shared },
      ...(field.options || []).map((option) =>
        h('option', {
          value: option.value,
          text: option.label,
          selected: String(field.value) === String(option.value),
        }),
      ),
    );
  }
  if (field.type === 'checkbox') {
    return h('input', {
      ...shared,
      type: 'checkbox',
      checked: Boolean(field.value),
    });
  }
  return h('input', {
    ...shared,
    type: field.type || 'text',
    value: field.value ?? '',
    placeholder: field.placeholder,
    min: field.min,
    max: field.max,
    step: field.step,
    inputmode: field.inputmode,
    maxlength: field.maxlength,
    minlength: field.minlength,
  });
}

function buildField(field) {
  if (field.type === 'static') return field.content;

  if (field.type === 'checkbox') {
    return h(
      'label',
      { class: 'field-toggle' },
      fieldControl(field),
      h(
        'span',
        { class: 'toggle-text' },
        h('strong', { text: field.label }),
        field.help ? h('span', { class: 'field-help', text: field.help }) : null,
      ),
    );
  }

  const control = fieldControl(field);
  const wrapper = h(
    'label',
    { class: `field${field.type === 'textarea' ? ' field-wide' : ''}` },
    h('span', { class: 'field-label', text: field.label }),
    control,
    field.help ? h('span', { class: 'field-help', text: field.help }) : null,
  );
  wrapper._control = control;
  return wrapper;
}

/**
 * 表单弹层。提交后 resolve 字段值对象；取消/关闭 resolve null。
 * @param {object} options
 */
export function formDialog({
  title,
  description = '',
  fields = [],
  submitText = '保存',
  cancelText = '取消',
  extra = null,
  validate = null,
} = {}) {
  return new Promise((resolve) => {
    sheetCounter += 1;
    const titleId = `sheet-title-${sheetCounter}`;
    const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': titleId });
    const panel = h('div', { class: 'sheet-panel' });
    const body = h('div', { class: 'sheet-body' });
    const footer = h('div', { class: 'sheet-actions' });
    const errorEl = h('p', { class: 'form-error', role: 'alert' });
    const form = h('form', { class: 'sheet-form', novalidate: true });
    const controls = new Map();
    let settled = false;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const close = (value = null) => {
      settle(value);
      if (dialog.open) dialog.close();
      else dialog.remove();
    };

    for (const field of fields) {
      const node = buildField(field);
      body.append(node);
      if (field.name && node instanceof Node) {
        if (field.type === 'static') continue;
        const control =
          field.type === 'checkbox' || field.type === 'select' || field.type === 'textarea'
            ? node.querySelector('input, select, textarea')
            : node._control || node.querySelector('input');
        if (control) controls.set(field.name, { field, control });
      }
    }
    if (extra) body.append(extra);
    body.append(errorEl);

    const submitButton = h('button', {
      type: 'submit',
      class: 'btn primary',
      text: submitText,
    });
    const cancelButton = h('button', {
      type: 'button',
      class: 'btn secondary',
      text: cancelText,
      onclick: () => close(null),
    });
    footer.append(cancelButton, submitButton);
    form.append(body, footer);

    const header = h(
      'div',
      { class: 'sheet-header' },
      h(
        'div',
        { class: 'sheet-heading' },
        h('h2', { id: titleId, text: title }),
        description ? h('p', { class: 'sheet-desc', text: description }) : null,
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          'aria-label': '关闭',
          onclick: () => close(null),
        },
        icon('close'),
      ),
    );

    panel.append(header, form);
    dialog.append(panel);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close(null);
    });
    dialog.addEventListener('close', () => {
      settle(null);
      dialog.remove();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = {};
      for (const [name, { field, control }] of controls) {
        values[name] = field.type === 'checkbox' ? control.checked : control.value;
      }

      // 浏览器基础校验（必填、数字范围）
      for (const { field, control } of controls.values()) {
        if (!control.checkValidity()) {
          errorEl.textContent = field.validationMessage || '请检查输入内容';
          control.focus();
          return;
        }
      }

      if (typeof validate === 'function') {
        try {
          const message = validate(values);
          if (message) {
            errorEl.textContent = message;
            return;
          }
        } catch (error) {
          errorEl.textContent = error?.message || '输入有误';
          return;
        }
      }
      close(values);
    });

    document.body.append(dialog);
    dialog.showModal();
    const firstControl = controls.values().next().value?.control;
    requestAnimationFrame(() => firstControl?.focus());
  });
}

/** 确认弹层，resolve boolean。 */
export async function confirmSheet({
  title = '确认操作',
  message = '',
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
} = {}) {
  const sheet = createSheet({ title });
  sheet.body.append(h('p', { class: 'confirm-message', text: message }));
  sheet.footer.append(
    h('button', {
      type: 'button',
      class: 'btn secondary',
      text: cancelText,
      onclick: () => sheet.close(false),
    }),
    h('button', {
      type: 'button',
      class: `btn ${danger ? 'danger-solid' : 'primary'}`,
      text: confirmText,
      onclick: () => sheet.close(true),
    }),
  );
  const value = await sheet.closed;
  return value === true;
}

/** 关闭所有打开的弹层（路由切换时）。 */
export function closeAllSheets() {
  for (const dialog of document.querySelectorAll('dialog.sheet[open]')) {
    try {
      dialog.close();
    } catch {
      dialog.remove();
    }
  }
}
