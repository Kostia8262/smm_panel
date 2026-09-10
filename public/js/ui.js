/** Мелкие общие детали интерфейса: сборка узлов, всплывашки, форматы. */

import { icon } from './icons.js';

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function frag(...nodes) {
  const f = document.createDocumentFragment();
  for (const n of nodes) if (n) f.append(n);
  return f;
}

/** Кнопка с иконкой и подписью — один вид на всю панель. */
export function button(label, { variant = '', iconName = '', onClick, title, disabled } = {}) {
  const b = el('button', `btn${variant ? ' btn--' + variant : ''}`);
  b.type = 'button';
  if (iconName) b.append(icon(iconName, { size: 16 }));
  if (label) b.append(el('span', null, label));
  if (title) b.title = title;
  if (disabled) b.disabled = true;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export function iconButton(iconName, { onClick, title, variant = 'quiet' } = {}) {
  const b = el('button', `btn btn--${variant} btn--icon`);
  b.type = 'button';
  b.append(icon(iconName, { size: 17 }));
  if (title) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export function panel(title, ...children) {
  const p = el('section', 'panel');
  if (title) {
    const head = el('div', 'panel__head');
    head.append(el('h2', null, title));
    p.append(head);
  }
  p.append(...children.filter(Boolean));
  return p;
}

export function note(kind, title, text) {
  const n = el('div', `note note--${kind}`);
  const iconName = kind === 'danger' ? 'alert' : kind === 'warn' ? 'alert' : kind === 'ok' ? 'check' : 'info';
  const ic = icon(iconName, { size: 16, className: 'note__icon' });
  n.append(ic);
  const body = el('div', 'note__body');
  body.append(el('div', 'note__title', title));
  if (text) body.append(el('div', 'note__text', text));
  n.append(body);
  return n;
}

export function empty(iconName, title, text, action) {
  const box = el('div', 'empty');
  box.append(icon(iconName, { size: 34, className: 'empty__icon' }));
  box.append(el('div', 'empty__title', title));
  if (text) box.append(el('p', 'empty__text', text));
  if (action) box.append(action);
  return box;
}

export function skeleton(height = 60) {
  const s = el('div', 'skeleton');
  s.style.height = `${height}px`;
  return s;
}

/* ------------------------------ всплывашки ------------------------------ */

let toastHost = null;

export function toast(message, kind = '') {
  if (!toastHost) {
    toastHost = el('div', 'toasts');
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.append(toastHost);
  }
  const t = el('div', `toast${kind ? ' toast--' + kind : ''}`);
  if (kind) t.append(icon(kind === 'ok' ? 'check' : 'alert', { size: 16 }));
  t.append(el('span', null, message));
  toastHost.append(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 200ms';
    setTimeout(() => t.remove(), 220);
  }, 3600);
}

/* -------------------------------- даты -------------------------------- */

const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function startOfWeek(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  d.setHours(0, 0, 0, 0);
  return d;
}

export function dowLabel(date) {
  return DOW[(date.getDay() + 6) % 7];
}

export function humanDate(date) {
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export function humanRange(from, to) {
  const sameMonth = from.getMonth() === to.getMonth();
  return sameMonth
    ? `${from.getDate()}–${to.getDate()} ${MONTHS[to.getMonth()]}`
    : `${humanDate(from)} — ${humanDate(to)}`;
}

const pad = (n) => String(n).padStart(2, '0');

/** Время в базе местное, без зоны: панель и сервер стоят в одном часовом поясе. */
export function toLocalInput(value) {
  return value ? value.slice(0, 16).replace(' ', 'T') : '';
}

export function fromLocalInput(value) {
  return value ? `${value.replace('T', ' ')}:00` : null;
}

export function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dbStamp(date) {
  return `${dateKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

export function humanBytes(n) {
  if (!n) return '—';
  return n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`;
}
