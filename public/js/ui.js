/**
 * UI-утилиты: создание DOM, аватары, форматирование времени, тосты, модалки.
 * Весь пользовательский контент вставляется через textContent — innerHTML не
 * используется нигде, где есть данные пользователей (защита от XSS).
 */

export function h(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'html') throw new Error('html запрещён: используйте text/children');
    else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, value);
  }
  append(element, children);
  return element;
}

export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* ------------------------------- Аватары ---------------------------------- */

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((p) => [...p][0] || '').join('');
  return (letters || '?').toUpperCase();
}

export function avatar(entity, { size = '', group = false, presence = null, tag = 'div' } = {}) {
  const classes = ['avatar'];
  if (size) classes.push(`avatar--${size}`);
  if (group) classes.push('avatar--group');
  const color = entity?.avatarColor || '#6c8cff';
  const node = h(tag, {
    class: classes.join(' '),
    style: { background: color },
    text: initials(entity?.title || entity?.displayName || entity?.username || '?'),
    title: entity?.title || entity?.displayName || entity?.username || '',
  });
  if (presence !== null && presence !== undefined) {
    node.appendChild(h('span', { class: `avatar__presence${presence ? ' is-online' : ''}` }));
  }
  return node;
}

/* --------------------------------- Время ---------------------------------- */

const pad = (n) => String(n).padStart(2, '0');

export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Сегодня';
  if (sameDay(d, yesterday)) return 'Вчера';
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const year = d.getFullYear() === today.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${months[d.getMonth()]}${year}`;
}

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function formatListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return formatTime(ts);
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return 'вчера';
  if (today.getTime() - ts < 6 * 86_400_000) {
    return ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getDay()];
  }
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

export function formatLastSeen(ts) {
  if (!ts) return 'был(а) давно';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'был(а) только что';
  if (diff < 3_600_000) return `был(а) ${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86_400_000) return `был(а) ${Math.floor(diff / 3_600_000)} ч назад`;
  if (diff < 2 * 86_400_000) return 'был(а) вчера';
  return `был(а) ${formatDay(ts)}`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

export function plural(n, forms) {
  const [one, few, many] = forms;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/* -------------------------------- Тосты ----------------------------------- */

const ICONS = { error: '⚠️', success: '✅', info: '💬', warning: '❕' };

export function toast(title, text = '', kind = 'info', ttl = 4200) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const node = h('div', { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' }, [
    h('span', { class: 'toast__icon', text: ICONS[kind] || ICONS.info }),
    h('div', { class: 'toast__body' }, [
      h('div', { class: 'toast__title', text: title }),
      text ? h('div', { class: 'toast__text', text }) : null,
    ]),
  ]);
  root.appendChild(node);
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 220);
  }, ttl);
}

export function toastError(err) {
  const message = err?.message || 'Неизвестная ошибка';
  const details = Array.isArray(err?.details) && err.details.length ? err.details.join('; ') : '';
  toast(message, details, 'error', 5600);
}

/* -------------------------------- Модалки --------------------------------- */

let activeModal = null;

export function closeModal() {
  if (!activeModal) return;
  activeModal.close();
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {Node|Node[]} opts.body
 * @param {Array<{label,kind,onClick,closeOnClick}>} [opts.actions]
 * @returns {{ close: () => void, root: HTMLElement }}
 */
export function openModal({ title, body, actions = [], wide = false, onClose } = {}) {
  closeModal();
  const root = document.getElementById('modal-root');
  clear(root);

  const foot = actions.length
    ? h('div', { class: 'modal__foot' }, actions.map((action) => h('button', {
      class: `btn ${action.kind === 'primary' ? 'btn--primary' : action.kind === 'danger' ? 'btn--danger' : 'btn--ghost'}`,
      text: action.label,
      type: 'button',
      onClick: async (evt) => {
        const button = evt.currentTarget;
        button.disabled = true;
        try {
          const result = await action.onClick?.();
          if (result !== false && action.closeOnClick !== false) handle.close();
        } catch (err) {
          toastError(err);
        } finally {
          button.disabled = false;
        }
      },
    })))
    : null;

  const modal = h('div', { class: `modal${wide ? ' modal--wide' : ''}`, role: 'dialog', 'aria-modal': 'true' }, [
    h('div', { class: 'modal__head' }, [
      h('div', { class: 'modal__title', text: title }),
      h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', text: '✕', onClick: () => handle.close() }),
    ]),
    h('div', { class: 'modal__body' }, body),
    foot,
  ]);

  const handle = {
    root: modal,
    close() {
      root.hidden = true;
      clear(root);
      document.removeEventListener('keydown', onKey);
      activeModal = null;
      onClose?.();
    },
  };

  function onKey(evt) {
    if (evt.key === 'Escape') handle.close();
  }

  root.appendChild(modal);
  root.hidden = false;
  root.addEventListener('mousedown', (evt) => {
    if (evt.target === root) handle.close();
  });
  document.addEventListener('keydown', onKey);
  activeModal = handle;

  const focusable = modal.querySelector('input, textarea, button.btn--primary');
  focusable?.focus();
  return handle;
}

export function confirmDialog({ title = 'Подтвердите', text, confirmLabel = 'Да', danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openModal({
      title,
      body: h('p', { style: { margin: '0', color: 'var(--text-dim)' }, text }),
      actions: [
        { label: 'Отмена', onClick: () => done(false) },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => done(true) },
      ],
      onClose: () => done(false),
    });
  });
}

/** Промпт с одним полем. */
export function promptDialog({ title, label, placeholder = '', value = '', confirmLabel = 'ОК', validate } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const input = h('input', { class: 'input', placeholder, value, maxlength: '80' });
    const error = h('div', { class: 'auth__error', hidden: true });
    openModal({
      title,
      body: [h('label', { class: 'field' }, [h('span', { class: 'field__label', text: label }), input]), error],
      actions: [
        { label: 'Отмена', onClick: () => done(null) },
        {
          label: confirmLabel,
          kind: 'primary',
          closeOnClick: false,
          onClick: () => {
            const v = input.value.trim();
            const problem = validate?.(v);
            if (problem) {
              error.textContent = problem;
              error.hidden = false;
              input.focus();
              return false;
            }
            done(v);
            return true;
          },
        },
      ],
      onClose: () => done(null),
    });
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        const problem = validate?.(input.value.trim());
        if (problem) {
          error.textContent = problem;
          error.hidden = false;
          return;
        }
        done(input.value.trim());
        closeModal();
      }
    });
  });
}

/* ----------------------------- Контент сообщений --------------------------- */

const URL_RE = /(https?:\/\/[^\s<>"']+)/gi;

/**
 * Текст → узлы DOM со ссылками. Никакого innerHTML: пользовательский текст
 * попадает только в textContent.
 */
export function renderText(text) {
  const fragment = document.createDocumentFragment();
  const source = String(text ?? '');
  let last = 0;
  let match;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(source)) !== null) {
    if (match.index > last) fragment.appendChild(document.createTextNode(source.slice(last, match.index)));
    const url = match[1].replace(/[.,;:!?)]+$/, '');
    fragment.appendChild(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow', text: url }));
    last = match.index + url.length;
  }
  if (last < source.length) fragment.appendChild(document.createTextNode(source.slice(last)));
  if (!fragment.childNodes.length) fragment.appendChild(document.createTextNode(source));
  return fragment;
}

/** Подсветка найденного: parts = [{text, hit}] с сервера. */
export function renderHighlighted(parts) {
  const fragment = document.createDocumentFragment();
  for (const part of parts || []) {
    if (!part?.text) continue;
    if (part.hit) fragment.appendChild(h('mark', { text: part.text }));
    else fragment.appendChild(renderText(part.text));
  }
  return fragment;
}

export function debounce(fn, wait = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Скролл вниз, если пользователь и так у нижней кромки. */
export function stickToBottom(node, force = false) {
  const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 140;
  if (force || nearBottom) {
    requestAnimationFrame(() => { node.scrollTop = node.scrollHeight; });
    return true;
  }
  return false;
}
