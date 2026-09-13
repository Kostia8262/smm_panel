/**
 * Один адрес: привести к виду, в котором его можно сравнивать, и сказать,
 * что с ним не так.
 *
 * Исправление никогда не подставляется молча. Опечатка в домене и русская
 * буква вместо латинской превращаются в предложение, которое человек
 * принимает в предпросмотре: «gmial.com» бывает и настоящим доменом, а
 * молча переписанный адрес — это письмо чужому человеку.
 */

import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { POPULAR_DOMAINS, BLOCKED_IN_UA, ROLE_LOCALS, DISPOSABLE_DOMAINS } from '../specs.js';

const INVISIBLE = /[\u00A0\u1680\u2000-\u200F\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/g;

/** Кириллица, неотличимая от латиницы на глаз. */
const HOMOGLYPHS = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't',
  у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ɡ: 'g',
};

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /[a-z]/;

/** Ключ стоп-листа: переживает стирание контакта. */
export function emailHash(email) {
  return createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

/** Для журнала и сообщений: `i***@gmail.com`. */
export function maskEmail(email) {
  const [local = '', domain = ''] = String(email).split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Снять обёртку, в которой адрес пришёл из ячейки или текста.
 * @returns {string} адрес в нижнем регистре, ещё не проверенный
 */
export function normalize(raw) {
  let s = String(raw ?? '').replace(INVISIBLE, ' ').trim();
  s = s.replace(/^mailto:/i, '');
  s = s.replace(/^[<("'«\[]+/, '').replace(/[>)"'»\].,;:!?]+$/, '');
  return s.trim().toLowerCase();
}

function validLocal(local) {
  if (!local || local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local);
}

function validDomain(domain) {
  if (!domain || domain.length > 253 || !domain.includes('.')) return false;
  const labels = domain.split('.');
  if (labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-') || !/^[a-z0-9-]+$/.test(l))) {
    return false;
  }
  const tld = labels[labels.length - 1];
  return /^[a-z]{2,}$/.test(tld) || /^xn--[a-z0-9-]+$/.test(tld);
}

export function isValidSyntax(email) {
  const at = email.lastIndexOf('@');
  if (at <= 0 || email.indexOf('@') !== at) return false;
  return validLocal(email.slice(0, at)) && validDomain(email.slice(at + 1));
}

/** Расстояние Дамерау — Левенштейна: перестановка соседних букв («gmial») — одна правка, а не две. */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Опечатка в популярном домене. Только рядом с популярными: иначе любой
 * редкий домен объявлялся бы опечаткой соседнего. Короткие домены не
 * трогаем вовсе — у «i.ua» одна правка до десятка настоящих доменов.
 */
export function domainTypo(domain) {
  if (POPULAR_DOMAINS.includes(domain) || domain.length < 6) return null;
  let best = null;
  let bestDist = Infinity;
  for (const candidate of POPULAR_DOMAINS) {
    const limit = candidate.length >= 8 ? 2 : 1;
    const dist = distance(domain, candidate);
    if (dist <= limit && dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

function fromHomoglyphs(text) {
  return [...text].map((ch) => HOMOGLYPHS[ch] ?? ch).join('');
}

/**
 * Полная проверка адреса. DNS здесь нет — он медленный и идёт отдельным
 * проходом по уникальным доменам (`mx.js`).
 *
 * @returns {{email: string, verdict: 'ok'|'warning'|'fixable'|'invalid', issues: string[], suggestion: string|null}}
 */
export function checkAddress(raw) {
  let email = normalize(raw);
  const issues = [];

  if (!email) return { email: '', verdict: 'invalid', issues: ['пустая ячейка'], suggestion: null };

  // Пробел внутри адреса — почти всегда опечатка, но склеивать молча нельзя:
  // «ivan petrov@…» мог означать и два разных ящика.
  if (/\s/.test(email)) {
    const joined = email.replace(/\s+/g, '');
    const repaired = checkAddress(joined);
    if (repaired.verdict !== 'invalid') {
      return { email, verdict: 'fixable', issues: ['пробел внутри адреса'], suggestion: repaired.suggestion || repaired.email };
    }
    return { email, verdict: 'invalid', issues: ['пробел внутри адреса'], suggestion: null };
  }

  const at = email.lastIndexOf('@');
  let local = at > 0 ? email.slice(0, at) : email;
  let domain = at > 0 ? email.slice(at + 1) : '';

  // Кириллица: либо двойники латиницы, набранные не в той раскладке, либо
  // настоящий кириллический домен вроде «пошта.укр».
  if (CYRILLIC.test(email)) {
    const domainMixed = CYRILLIC.test(domain) && LATIN.test(domain.replace(/\.[^.]*$/, ''));
    const localCyr = CYRILLIC.test(local);
    if (localCyr || domainMixed) {
      const repaired = fromHomoglyphs(email);
      if (!CYRILLIC.test(repaired) && isValidSyntax(repaired)) {
        return {
          email,
          verdict: 'fixable',
          issues: ['русская буква вместо латинской — на глаз не отличить, письмо не дойдёт'],
          suggestion: repaired,
        };
      }
      return { email, verdict: 'invalid', issues: ['кириллица в адресе'], suggestion: null };
    }
    const ascii = domainToASCII(domain);
    if (!ascii) return { email, verdict: 'invalid', issues: ['домен не читается'], suggestion: null };
    domain = ascii;
    email = `${local}@${domain}`;
  }

  if (!isValidSyntax(email)) {
    return { email, verdict: 'invalid', issues: ['не похоже на адрес'], suggestion: null };
  }

  const typo = domainTypo(domain);
  if (typo) {
    return {
      email,
      verdict: 'fixable',
      issues: [`похоже на опечатку в «${typo}»`],
      suggestion: `${local}@${typo}`,
    };
  }

  const bareLocal = local.split('+')[0];
  if (ROLE_LOCALS.includes(bareLocal)) issues.push('ящик должности, а не человека');
  if (DISPOSABLE_DOMAINS.includes(domain)) issues.push('одноразовая почта');
  if (BLOCKED_IN_UA.includes(domain)) issues.push('почта заблокирована в Украине — вряд ли читается');

  return { email, verdict: issues.length ? 'warning' : 'ok', issues, suggestion: null };
}

export function domainOf(email) {
  return String(email).slice(String(email).lastIndexOf('@') + 1);
}
