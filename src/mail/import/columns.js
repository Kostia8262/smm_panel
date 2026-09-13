/**
 * Где в таблице заголовок, где адрес, где имя.
 *
 * Колонка адреса ищется по содержимому, а не по названию: в базах школ она
 * подписана как угодно — «Email», «Пошта», «Контакт», «E-mail 1 - Value» из
 * Google Контактов — или не подписана вовсе. Имя, наоборот, по содержимому не
 * узнать (город и курс тоже состоят из букв), поэтому оно — по заголовку, а
 * без заголовка — по осторожной догадке, которую человек поправит.
 */

import { EMAIL_COLUMN_SHARE, NAME_HEADERS } from '../specs.js';
import { hasEmail } from './text.js';

const EMAIL_HEADERS = [
  'email', 'e-mail', 'e mail', 'email address', 'e-mail address', 'mail', 'почта', 'пошта',
  'электронная почта', 'електронна пошта', 'эл. почта', 'ел. пошта', 'имейл', 'імейл', 'емейл',
];

/** Роли колонки, которые человек выбирает в предпросмотре. */
export const COLUMN_ROLES = {
  email: 'Адрес',
  name: 'Имя целиком',
  first: 'Имя',
  last: 'Фамилия',
  attr: 'Сохранить колонкой',
  skip: 'Не сохранять',
};

export function normHeader(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’ʼ`´]/g, "'")
    .replace(/[:*]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function headerIs(list, value) {
  const h = normHeader(value);
  return Boolean(h) && list.includes(h);
}

function isEmailHeader(value) {
  const h = normHeader(value);
  return EMAIL_HEADERS.includes(h) || /^e-?mail\b/.test(h) || /\bemail\b/.test(h);
}

/**
 * Первая строка — заголовок, если в ней нет адресов, а ниже они есть, или если
 * она состоит из узнаваемых названий колонок.
 */
export function detectHeader(rows) {
  if (rows.length < 2) return false;
  const first = rows[0];
  if (first.some((c) => hasEmail(c))) return false;
  if (first.some((c) => isEmailHeader(c) || headerIs(NAME_HEADERS.full, c) || headerIs(NAME_HEADERS.last, c))) {
    return true;
  }
  return rows.slice(1, 6).some((r) => r.some((c) => hasEmail(c)));
}

function looksLikeName(value) {
  const v = String(value || '').trim();
  return v.length >= 2 && v.length <= 60 && /^[\p{L}][\p{L}'’ʼ .-]*$/u.test(v);
}

/**
 * @param {string[][]} data — строки без заголовка
 * @param {string[]|null} header
 * @returns {Record<number, keyof COLUMN_ROLES>} роль каждой колонки
 */
export function detectRoles(data, header) {
  const width = Math.max(header?.length || 0, ...data.slice(0, 500).map((r) => r.length), 0);
  const sample = data.slice(0, 500);
  const roles = {};

  const shares = [];
  for (let col = 0; col < width; col++) {
    let filled = 0;
    let emails = 0;
    let names = 0;
    for (const row of sample) {
      const cell = String(row[col] ?? '').trim();
      if (!cell) continue;
      filled++;
      if (hasEmail(cell)) emails++;
      else if (looksLikeName(cell)) names++;
    }
    shares.push({ col, email: filled ? emails / filled : 0, name: filled ? names / filled : 0, filled });
    roles[col] = 'attr';
  }

  let emailCols = shares.filter((s) => s.email >= EMAIL_COLUMN_SHARE).map((s) => s.col);
  if (!emailCols.length && header) emailCols = shares.filter((s) => isEmailHeader(header[s.col])).map((s) => s.col);
  if (!emailCols.length) {
    // Редко заполненная колонка адресов: берём самую «адресную», если она есть.
    const best = [...shares].sort((a, b) => b.email - a.email)[0];
    if (best?.email > 0) emailCols = [best.col];
  }
  for (const col of emailCols) roles[col] = 'email';

  if (header) {
    const free = (col) => roles[col] === 'attr';
    const lastCol = header.findIndex((h, col) => free(col) && headerIs(NAME_HEADERS.last, h));
    const fullCol = header.findIndex(
      (h, col) => free(col) && headerIs(NAME_HEADERS.full, h) && !headerIs(NAME_HEADERS.first, h)
    );
    const firstCol = header.findIndex((h, col) => free(col) && col !== lastCol && headerIs(NAME_HEADERS.first, h));

    if (fullCol >= 0) roles[fullCol] = 'name';
    else if (firstCol >= 0 && lastCol >= 0) {
      roles[firstCol] = 'first';
      roles[lastCol] = 'last';
    } else if (firstCol >= 0) roles[firstCol] = 'name';
  } else {
    const guess = shares.find((s) => roles[s.col] === 'attr' && s.filled && s.name >= EMAIL_COLUMN_SHARE);
    if (guess) roles[guess.col] = 'name';
  }

  return roles;
}

/** Подписи колонок: из заголовка, а без него — «Колонка 3». Повторы нумеруются. */
export function columnLabels(header, width) {
  const seen = new Map();
  return Array.from({ length: width }, (_, col) => {
    const base = String(header?.[col] ?? '').trim() || `Колонка ${col + 1}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} ${n}` : base;
  });
}
