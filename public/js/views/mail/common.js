/**
 * Общее для экранов рассылки: состояния словами, даты, счётчики, мелкие узлы.
 *
 * Состояние контакта и вердикт строки подписаны словом, а не цветом без
 * подписи: так же, как статус поста в календаре (DESIGN.md).
 */

import { el, button, humanDate } from '../../ui.js';
import { icon } from '../../icons.js';

export const STATUS_TAG = {
  active: { cls: 'tag--ok', text: 'активен' },
  unsubscribed: { cls: 'tag--warn', text: 'отписался' },
  bounced: { cls: 'tag--danger', text: 'адреса нет' },
  invalid: { cls: 'tag--danger', text: 'ошибочный' },
};

export const VERDICT_TAG = {
  ok: { cls: 'tag--ok', text: 'готов', tile: 'ok', title: 'Готовы' },
  warning: { cls: 'tag--warn', text: 'внимание', tile: 'warn', title: 'С предупреждением' },
  fixable: { cls: 'tag--gold', text: 'опечатка?', tile: 'gold', title: 'Похоже на опечатку' },
  invalid: { cls: 'tag--danger', text: 'ошибка', tile: 'danger', title: 'Ошибочные' },
  duplicate: { cls: '', text: 'повтор', tile: '', title: 'Повторы' },
  suppressed: { cls: 'tag--danger', text: 'стоп-лист', tile: 'danger', title: 'В стоп-листе' },
};

export function tag({ cls, text }) {
  return el('span', `tag ${cls || ''}`.trim(), text);
}

export function num(n) {
  return Number(n || 0).toLocaleString('ru-RU');
}

/** «1 адрес», «3 адреса», «12 адресов» — с числом впереди. */
export function plural(n, [one, few, many]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${num(n)} ${word}`;
}

export const ADDRESSES = ['адрес', 'адреса', 'адресов'];

/** ISO-время с зоной → «13 сентября» или «13 сентября 2025», если год не текущий. */
export function day(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${humanDate(d)}${year}`;
}

/** Плитка сводки — та же, что у журнала: один вид на всю панель. */
export function tile(label, value, sub, tone = '') {
  const box = el('div', `jsum__item${tone ? ` jsum__item--${tone}` : ''}`);
  box.append(el('div', 'eyebrow', label), el('div', 'jsum__value num', value), el('div', 'jsum__sub', sub));
  return box;
}

/** Возврат к списку баз: вложенные экраны рассылки живут внутри раздела. */
export function backLink(text = 'Базы', hash = '#/mail') {
  const a = el('a', 'mail-back');
  a.href = hash;
  a.append(icon('chevronLeft', { size: 15 }), el('span', null, text));
  return a;
}

export function field(label, control, hint = '') {
  const wrap = el('div', 'field');
  const id = `m-${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  const lab = el('label', 'field__label', label);
  lab.htmlFor = id;
  wrap.append(lab, control);
  if (hint) wrap.append(el('span', 'field__hint', hint));
  return wrap;
}

export function input(value = '', { placeholder = '', type = 'text' } = {}) {
  const node = el('input', 'input');
  node.type = type;
  node.value = value;
  if (placeholder) node.placeholder = placeholder;
  return node;
}

export function select(options, value = '') {
  const node = el('select', 'select');
  for (const [id, title] of options) node.append(new Option(title, id));
  node.value = value;
  return node;
}

/** Переключатель-фильтр в ряду чипов. */
export function chip(text, pressed, onClick) {
  const b = el('button', 'chip', text);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Вопрос с причиной прямо на месте, без системного prompt(): причина
 * отписки или возврата подписки ложится в стоп-лист и журнал, и писать её в
 * сером окошке браузера — верный способ получить пустую строку.
 */
export function ask(host, { placeholder, confirmLabel, required = false, danger = false, onConfirm }) {
  host.querySelector('.mail-ask')?.remove();
  const row = el('form', 'mail-ask');
  const text = input('', { placeholder });
  const ok = button(confirmLabel, { variant: danger ? 'danger' : 'primary' });
  ok.type = 'submit';
  const cancel = button('Отмена', { variant: 'quiet', onClick: () => row.remove() });
  row.append(text, ok, cancel);
  row.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (required && !text.value.trim()) {
      text.focus();
      return;
    }
    ok.disabled = true;
    try {
      await onConfirm(text.value.trim());
      row.remove();
    } finally {
      ok.disabled = false;
    }
  });
  host.append(row);
  text.focus();
  return row;
}

/** Параметры экрана из адреса: `#/mail/lists/5?status=active&q=оля`. */
export function hashParams() {
  return new URLSearchParams(location.hash.split('?')[1] || '');
}

export function setHashParams(path, params) {
  const clean = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === '' || value === null || value === undefined) continue;
    if (key === 'page' && Number(value) <= 1) continue;
    clean.set(key, String(value));
  }
  const query = clean.toString();
  history.replaceState(null, '', `${path}${query ? `?${query}` : ''}`);
}

/**
 * Вкладки раздела: «Базы» и «Ящики». Ящики видит только владелец — у
 * СММщика вкладка одна, и полосу из одной вкладки не рисуем.
 */
export function mailTabs(ctx, active) {
  if (!ctx.can('mail_senders')) return null;
  const nav = el('nav', 'mail-tabs');
  nav.setAttribute('aria-label', 'Разделы рассылки');
  for (const [id, title, hash] of [
    ['lists', 'Базы', '#/mail'],
    ['senders', 'Ящики', '#/mail/senders'],
  ]) {
    const a = el('a', 'mail-tab', title);
    a.href = hash;
    if (id === active) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
  return nav;
}
