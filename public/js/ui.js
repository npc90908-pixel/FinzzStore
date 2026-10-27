// ============================================================================
// UI KIT — reusable DOM components.
// Rules: text goes through textContent; user data is never assigned to
// innerHTML. Only developer-authored SVG path strings are trusted markup.
// ============================================================================
import { icon } from './icons.js';

let uid = 0;
export const nextId = (prefix = 'fz') => `${prefix}-${++uid}`;

/**
 * Create an element.
 * props: class, text, html (trusted only), attrs{}, on{Event}, dataset{}, style{}
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value); // developer-authored only
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key === 'attrs' && typeof value === 'object') {
      for (const [attr, attrValue] of Object.entries(value)) {
        if (attrValue === false || attrValue === null || attrValue === undefined) continue;
        node.setAttribute(attr, attrValue === true ? '' : String(attrValue));
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list' && key !== 'form') {
      node[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  appendChildren(f, children);
  return f;
};

// ---------------------------------------------------------------------------
// PRIMITIVES
// ---------------------------------------------------------------------------
export function Badge({ tone = 'neutral', children, dot = false, pulse = false, title = null }) {
  return el(
    'span',
    { class: `badge badge--${tone}${pulse ? ' badge--live' : ''}`, attrs: title ? { title } : {} },
    dot ? el('span', { class: 'badge__dot' }) : null,
    el('span', { text: children })
  );
}

export function Spinner({ size = 'md', label = 'Memuat…' }) {
  return el('span', { class: `spinner${size === 'lg' ? ' spinner--lg' : ''}`, attrs: { role: 'status', 'aria-label': label } });
}

export function LoadingBlock({ label = 'Memuat data…' } = {}) {
  return el('div', { class: 'loading-block' }, Spinner({}), el('span', { text: label }));
}

export function Button({
  variant = 'default',
  size = 'md',
  iconName = null,
  iconRight = null,
  type = 'button',
  onClick = null,
  children = null,
  disabled = false,
  block = false,
  title = null,
  attrs = {}
}) {
  const classes = ['btn'];
  if (variant !== 'default') classes.push(`btn--${variant}`);
  if (size === 'sm') classes.push('btn--sm');
  if (size === 'lg') classes.push('btn--lg');
  if (block) classes.push('btn--block');
  if (!children && iconName) classes.push('btn--icon');

  const button = el(
    'button',
    {
      class: classes.join(' '),
      attrs: { type, ...(title ? { title } : {}), ...attrs },
      disabled
    },
    iconName ? icon(iconName, { size: size === 'lg' ? 19 : 17 }) : null,
    children ? el('span', { text: children }) : null,
    iconRight ? icon(iconRight, { size: 16 }) : null
  );

  if (onClick) {
    button.addEventListener('click', (event) => {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
        event.preventDefault();
        return;
      }
      onClick(event);
    });
  }
  return button;
}

/** Run an async action with a loading state and double-submit protection. */
export async function runWithLoading(button, asyncFn, { loadingLabel = 'Memproses…' } = {}) {
  if (!button || button.dataset.loading === '1') return undefined;
  const original = Array.from(button.childNodes).map((n) => n.cloneNode(true));
  button.dataset.loading = '1';
  button.disabled = true;
  button.replaceChildren(Spinner({}), el('span', { text: loadingLabel }));
  try {
    return await asyncFn();
  } finally {
    button.dataset.loading = '0';
    button.disabled = false;
    button.replaceChildren(...original);
  }
}

export function Card({ title = null, subtitle = null, actions = null, children, variant = null, flush = false, footer = null }) {
  const card = el('section', { class: `card${variant ? ` card--${variant}` : ''}` });
  if (title || actions) {
    card.appendChild(
      el(
        'header',
        { class: 'card__head' },
        el('div', {}, el('h3', { class: 'card__title', text: title }), subtitle ? el('p', { class: 'card__subtitle', text: subtitle }) : null),
        actions
      )
    );
  }
  card.appendChild(el('div', { class: `card__body${flush ? ' card__body--flush' : ''}` }, children));
  if (footer) card.appendChild(el('div', { class: 'card__foot' }, footer));
  return card;
}

export function StatCard({ label, value, hint = null, iconName = null, tone = 'brand' }) {
  return el(
    'div',
    { class: 'stat' },
    el(
      'div',
      { class: 'row row--between' },
      el('span', { class: 'stat__label', text: label }),
      iconName
        ? el('span', { class: 'stat__icon', style: { background: `var(--${tone}-soft)`, color: `var(--${tone})` } }, icon(iconName, { size: 17 }))
        : null
    ),
    el('span', { class: 'stat__value', text: value }),
    hint ? el('span', { class: 'stat__hint', text: hint }) : null
  );
}

export function Alert({ tone = 'info', title = null, children, iconName = null }) {
  const iconForTone = { info: 'info', success: 'check', warning: 'alert', danger: 'alert' };
  return el(
    'div',
    { class: `alert alert--${tone}`, attrs: { role: tone === 'danger' ? 'alert' : 'status' } },
    icon(iconName || iconForTone[tone] || 'info', { size: 18 }),
    el('div', {}, title ? el('div', { class: 'alert__title', text: title }) : null, el('div', { text: children }))
  );
}

export function EmptyState({ title, description = null, iconName = 'inbox', action = null }) {
  return el(
    'div',
    { class: 'empty' },
    el('div', { class: 'empty__art' }, icon(iconName, { size: 40, strokeWidth: 1.3 })),
    el('div', { class: 'empty__title', text: title }),
    description ? el('p', { class: 'empty__desc', text: description }) : null,
    action
  );
}

export function Skeleton({ lines = 3, card = false } = {}) {
  if (card) {
    return el(
      'div',
      { class: 'skeleton-card' },
      el('div', { class: 'skeleton skeleton-circle' }),
      el('div', { class: 'skeleton skeleton-text skeleton-text--lg' }),
      el('div', { class: 'skeleton skeleton-text' }),
      el('div', { class: 'skeleton skeleton-text skeleton-text--sm' })
    );
  }
  return el(
    'div',
    { attrs: { 'aria-hidden': 'true' } },
    Array.from({ length: lines }, (_, i) =>
      el('div', { class: 'skeleton skeleton-text', style: { width: i === lines - 1 ? '55%' : `${90 - i * 8}%` } })
    )
  );
}

// ---------------------------------------------------------------------------
// FORM CONTROLS
// ---------------------------------------------------------------------------
export function Input({
  label = null,
  name,
  type = 'text',
  value = '',
  placeholder = '',
  hint = null,
  required = false,
  autocomplete = 'off',
  inputMode = null,
  min = null,
  max = null,
  step = null,
  maxlength = null,
  disabled = false,
  onInput = null,
  labelAction = null
}) {
  const id = nextId('in');
  const input = el('input', {
    class: 'input',
    attrs: {
      id,
      name,
      type,
      placeholder,
      required: required || null,
      autocomplete,
      inputmode: inputMode || null,
      min: min ?? null,
      max: max ?? null,
      step: step ?? null,
      maxlength: maxlength ?? null,
      'aria-describedby': hint ? `${id}-hint` : null,
      ...(disabled ? { disabled: true } : {})
    },
    value
  });
  if (onInput) input.addEventListener('input', onInput);

  return el(
    'div',
    { class: 'field' },
    label
      ? el(
          'div',
          { class: 'field__label-row' },
          el('label', { class: 'field__label', attrs: { for: id }, text: label }),
          labelAction
        )
      : null,
    input,
    hint ? el('span', { class: 'field__hint', attrs: { id: `${id}-hint` }, text: hint }) : null,
    el('span', { class: 'field__error', attrs: { 'data-error-for': name, hidden: true } })
  );
}

export function Select({ label = null, name, options = [], value = '', hint = null, onChange = null }) {
  const id = nextId('sel');
  const select = el('select', { class: 'select', attrs: { id, name } });
  for (const option of options) {
    const opt = el('option', { value: option.value, text: option.label });
    if (String(option.value) === String(value)) opt.selected = true;
    select.appendChild(opt);
  }
  if (onChange) select.addEventListener('change', onChange);
  return el(
    'div',
    { class: 'field' },
    label ? el('label', { class: 'field__label', attrs: { for: id }, text: label }) : null,
    el('div', { class: 'select-wrap' }, select),
    hint ? el('span', { class: 'field__hint', text: hint }) : null
  );
}

export function Textarea({ label = null, name, value = '', placeholder = '', rows = 4, maxlength = 500, hint = null }) {
  const id = nextId('ta');
  return el(
    'div',
    { class: 'field' },
    label ? el('label', { class: 'field__label', attrs: { for: id }, text: label }) : null,
    el('textarea', { class: 'textarea', attrs: { id, name, rows, placeholder, maxlength } , value }),
    hint ? el('span', { class: 'field__hint', text: hint }) : null
  );
}

export function Checkbox({ label, name, checked = false, required = false }) {
  const id = nextId('cb');
  return el(
    'label',
    { class: 'checkbox', attrs: { for: id } },
    el('input', { attrs: { id, type: 'checkbox', name, required: required || null }, checked }),
    el('span', { text: label })
  );
}

export function fieldError(form, name, message) {
  const node = form.querySelector(`[data-error-for="${name}"]`);
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
  const input = form.querySelector(`[name="${name}"]`);
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

export function clearFormErrors(form) {
  for (const node of form.querySelectorAll('[data-error-for]')) {
    node.textContent = '';
    node.hidden = true;
  }
  for (const input of form.querySelectorAll('[aria-invalid]')) input.setAttribute('aria-invalid', 'false');
}

// ---------------------------------------------------------------------------
// DATA DISPLAY
// ---------------------------------------------------------------------------
export function Table({ columns, rows, empty = null, compact = false }) {
  const table = el('table', { class: `table${compact ? ' table--compact' : ''}` });
  const thead = el('thead');
  const headRow = el('tr');
  for (const col of columns) {
    headRow.appendChild(el('th', { class: col.align === 'right' ? 'table__num' : '', text: col.label }));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  if (!rows || rows.length === 0) {
    tbody.appendChild(
      el('tr', {}, el('td', { attrs: { colspan: String(columns.length) } }, empty || EmptyState({ title: 'Belum ada data' })))
    );
  } else {
    for (const row of rows) {
      const tr = el('tr');
      for (const col of columns) {
        const cell = el('td', { class: col.align === 'right' ? 'table__num' : '' });
        const value = typeof col.render === 'function' ? col.render(row) : row[col.key];
        if (value instanceof Node) cell.appendChild(value);
        else cell.textContent = value ?? '—';
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  return el('div', { class: 'table-wrap scroll-x' }, table);
}

export function Tabs({ items, active, onChange }) {
  const container = el('div', { class: 'tabs', attrs: { role: 'tablist' } });
  for (const item of items) {
    const btn = el('button', {
      class: 'tabs__btn',
      attrs: { type: 'button', role: 'tab', 'aria-selected': String(item.id === active) },
      text: item.label
    });
    btn.addEventListener('click', () => onChange(item.id));
    container.appendChild(btn);
  }
  return container;
}

export function CopyField({ value, label = null }) {
  const text = el('span', { class: 'grow truncate', text: value });
  const button = Button({
    variant: 'ghost',
    size: 'sm',
    iconName: 'copy',
    title: 'Salin',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(value);
        button.replaceChildren(icon('check', { size: 16 }));
        setTimeout(() => button.replaceChildren(icon('copy', { size: 16 })), 1600);
      } catch {
        toast({ type: 'error', title: 'Gagal menyalin', message: 'Salin manual dari kotak di samping.' });
      }
    }
  });
  return el(
    'div',
    { class: 'stack', style: { gap: '6px' } },
    label ? el('span', { class: 'section-label', text: label }) : null,
    el('div', { class: 'copy-field' }, text, button)
  );
}

export function Pagination({ page, pages, onChange }) {
  if (!pages || pages <= 1) return null;
  return el(
    'div',
    { class: 'pagination' },
    Button({ size: 'sm', variant: 'outline', iconName: 'chevronLeft', attrs: { 'aria-label': 'Halaman sebelumnya' }, disabled: page <= 1, onClick: () => onChange(page - 1), title: 'Sebelumnya' }),
    el('span', { class: 'text-sm text-muted', text: `Halaman ${page} dari ${pages}` }),
    Button({ size: 'sm', variant: 'outline', iconName: 'chevronRight', attrs: { 'aria-label': 'Halaman berikutnya' }, disabled: page >= pages, onClick: () => onChange(page + 1), title: 'Berikutnya' })
  );
}

export function ProgressBar({ value }) {
  const clamped = Math.max(0, Math.min(100, Number(value) || 0));
  return el('div', { class: 'progress', attrs: { role: 'progressbar', 'aria-valuenow': String(clamped), 'aria-valuemin': '0', 'aria-valuemax': '100' } },
    el('div', { class: 'progress__bar', style: { width: `${clamped}%` } }));
}

export function Avatar({ name = '', email = '' }) {
  const source = (name || email || '?').trim();
  const initials = source.slice(0, 2).toUpperCase();
  return el('span', { class: 'avatar', attrs: { 'aria-hidden': 'true' }, text: initials });
}

// ---------------------------------------------------------------------------
// MODAL
// ---------------------------------------------------------------------------
export function Modal({ title, description = null, body, actions = [], onClose, size = null }) {
  const titleId = nextId('modal-title');
  const previouslyFocused = document.activeElement;

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKeydown);
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    onClose?.();
  };

  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key === 'Tab') {
      const focusable = dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const dialog = el(
    'div',
    { class: 'modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, style: size ? { width: `min(100%, ${size})` } : {} },
    el(
      'div',
      { class: 'modal__head' },
      el('div', {}, el('h3', { class: 'modal__title', attrs: { id: titleId }, text: title }), description ? el('p', { class: 'card__subtitle', text: description }) : null),
      el('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Tutup dialog' }, onClick: close }, icon('x', { size: 18 }))
    ),
    el('div', { class: 'modal__body' }, body),
    actions.length ? el('div', { class: 'modal__foot' }, actions) : null
  );

  const backdrop = el('div', { class: 'modal-backdrop' }, dialog);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKeydown);
  const firstFocusable = dialog.querySelector('input, select, textarea, button.btn--primary, button');
  firstFocusable?.focus();

  return { close, element: dialog };
}

// ---------------------------------------------------------------------------
// TOAST
// ---------------------------------------------------------------------------
let toastRegion = null;

function ensureToastRegion() {
  if (toastRegion?.isConnected) return toastRegion;
  toastRegion = el('div', { class: 'toast-region', attrs: { 'aria-live': 'polite', 'aria-relevant': 'additions' } });
  document.body.appendChild(toastRegion);
  return toastRegion;
}

export function toast({ type = 'info', title, message = null, timeout = 5200 }) {
  const region = ensureToastRegion();
  const iconFor = { success: 'check', error: 'alert', warning: 'alert', info: 'info' };
  const node = el(
    'div',
    { class: `toast toast--${type}`, attrs: { role: type === 'error' ? 'alert' : 'status' } },
    el('span', { class: 'toast__icon' }, icon(iconFor[type] || 'info', { size: 18 })),
    el('div', { class: 'toast__body' }, el('div', { class: 'toast__title', text: title }), message ? el('div', { class: 'toast__msg', text: message }) : null),
    el('button', { class: 'toast__close', attrs: { type: 'button', 'aria-label': 'Tutup notifikasi' }, onClick: () => node.remove() }, icon('x', { size: 14 }))
  );
  region.appendChild(node);
  if (timeout > 0) setTimeout(() => node.remove(), timeout);
  return node;
}

// ---------------------------------------------------------------------------
// FILE UPLOAD (proof of transfer)
// ---------------------------------------------------------------------------
export function FileUpload({ name = 'proof', accept = 'image/png,image/jpeg,image/webp,application/pdf', maxBytes = 5 * 1024 * 1024, onChange }) {
  const input = el('input', { attrs: { type: 'file', name, accept } });
  const preview = el('div', { class: 'stack', style: { gap: '8px', alignItems: 'center' } });
  const zone = el(
    'label',
    { class: 'upload' },
    input,
    icon('upload', { size: 26 }),
    el('span', { class: 'upload__title', text: 'Unggah bukti transfer' }),
    el('span', { class: 'upload__hint', text: `PNG, JPG, WEBP, atau PDF · maksimal ${Math.round(maxBytes / 1024 / 1024)} MB` })
  );

  const handle = (file) => {
    if (!file) return;
    if (file.size > maxBytes) {
      toast({ type: 'error', title: 'File terlalu besar', message: `Maksimal ${Math.round(maxBytes / 1024 / 1024)} MB.` });
      input.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      preview.replaceChildren();
      if (file.type.startsWith('image/')) {
        preview.appendChild(el('img', { class: 'upload__preview', attrs: { src: String(reader.result), alt: 'Pratinjau bukti transfer' } }));
      }
      preview.appendChild(el('span', { class: 'upload__hint', text: `${file.name} · ${Math.round(file.size / 1024)} KB` }));
      onChange?.({ file, dataUrl: String(reader.result) });
    };
    reader.readAsDataURL(file);
  };

  input.addEventListener('change', () => handle(input.files?.[0]));
  for (const eventName of ['dragenter', 'dragover']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add('upload--dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove('upload--dragging');
    });
  }
  zone.addEventListener('drop', (event) => handle(event.dataTransfer?.files?.[0]));

  return { zone, preview, input, reset: () => { input.value = ''; preview.replaceChildren(); } };
}

// ---------------------------------------------------------------------------
// MISC
// ---------------------------------------------------------------------------
export function KeyValue({ items }) {
  const dl = el('dl', { class: 'kv' });
  for (const item of items) {
    dl.appendChild(el('dt', { text: item.label }));
    const dd = el('dd');
    if (item.value instanceof Node) dd.appendChild(item.value);
    else dd.textContent = item.value ?? '—';
    dl.appendChild(dd);
  }
  return dl;
}

export function PageHeader({ title, subtitle = null, actions = null }) {
  return el(
    'div',
    { class: 'page__head' },
    el('div', {}, el('h1', { class: 'page__title', text: title }), subtitle ? el('p', { class: 'page__subtitle', text: subtitle }) : null),
    actions ? el('div', { class: 'row row--wrap' }, actions) : null
  );
}

/** Simple client-side form reader that never trusts the browser alone. */
export function formValues(form) {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) {
    data[key] = typeof value === 'string' ? value : value.name;
  }
  return data;
}
