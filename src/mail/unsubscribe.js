/**
 * Отписка по ссылке из письма (docs/рассылка.md, §11).
 *
 * Ссылка подписана HMAC ключом, выведенным из ключа панели: подделать её или
 * перебрать чужие номера нельзя, а срока у неё нет — ссылка в письме годичной
 * давности обязана работать.
 *
 * **GET не отписывает.** Почтовые сканеры (корпоративные фильтры, Outlook)
 * открывают все ссылки письма, и люди отписывались бы, не открыв его. GET
 * показывает страницу с кнопкой; отписывает POST — кнопка страницы или
 * «отписаться» самой почтовой программы по RFC 8058.
 *
 * Страница — по-украински, как и письма: её видит ученик, а не команда.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveKey } from '../secrets.js';
import * as store from './store.js';
import { maskEmail } from './import/address.js';

let key = null;
const hmacKey = () => (key ||= deriveKey('mail-unsubscribe'));

function sign(payload) {
  return createHmac('sha256', hmacKey()).update(payload).digest().subarray(0, 16).toString('base64url');
}

/**
 * @param {{projectId: number, contactId: number, campaignId?: number}} target — campaignId 0 у пробного письма
 */
export function tokenFor({ projectId, contactId = 0, campaignId = 0 }) {
  const payload = Buffer.from(JSON.stringify({ p: Number(projectId), c: Number(contactId), m: Number(campaignId) })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** @returns {{projectId: number, contactId: number, campaignId: number, test: boolean}|null} */
export function readToken(token) {
  const [payload, mac] = String(token || '').split('.');
  if (!payload || !mac || payload.length > 200) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isInteger(data.p) || !Number.isInteger(data.c) || !Number.isInteger(data.m)) return null;
    return { projectId: data.p, contactId: data.c, campaignId: data.m, test: data.c === 0 };
  } catch {
    return null;
  }
}

export function unsubscribeUrl(publicBase, token) {
  return `${String(publicBase).replace(/\/$/, '')}/u/${token}`;
}

/** Заголовки письма: кнопка «отписаться» в Gmail и других почтовых программах. */
export function unsubscribeHeaders(url) {
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

/* --------------------------------- страница --------------------------------- */

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page({ title, text, school = '', form = null, note = '' }) {
  const button = form
    ? `<form method="post" class="u-form"><input type="hidden" name="action" value="${escapeHtml(form.action)}"><button type="submit" class="u-btn${form.quiet ? ' u-btn--quiet' : ''}">${escapeHtml(form.label)}</button></form>`
    : '';
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/unsubscribe.css">
</head>
<body>
<main class="u-card">
${school ? `<p class="u-school">${escapeHtml(school)}</p>` : ''}
<h1>${escapeHtml(title)}</h1>
<p class="u-text">${escapeHtml(text)}</p>
${button}
${note ? `<p class="u-note">${escapeHtml(note)}</p>` : ''}
</main>
</body>
</html>`;
}

/** Та же страница — для подтверждения подписки с сайта: один вид у всех публичных страниц рассылки. */
export { page as publicPage };

const BROKEN = {
  title: 'Посилання пошкоджене',
  text: 'Ми не змогли розпізнати це посилання. Скопіюйте його з листа повністю або напишіть нам — відпишемо вручну.',
};

/**
 * @param {{token: string, method: 'GET'|'POST', body?: object, projectTitle: (id: number) => string}} req
 * @returns {{status: number, html?: string, text?: string}}
 */
export function handle({ token, method, body = {}, projectTitle }) {
  const target = readToken(token);
  if (!target) return { status: 404, html: page(BROKEN) };
  const school = projectTitle(target.projectId) || '';

  // RFC 8058: почтовая программа шлёт POST с телом List-Unsubscribe=One-Click.
  const oneClick = method === 'POST' && body['List-Unsubscribe'] === 'One-Click';

  if (target.test) {
    if (oneClick) return { status: 200, text: 'OK' };
    return {
      status: 200,
      html: page({
        school,
        title: 'Це пробний лист',
        text: 'Посилання для відписки працює. У справжньому листі тут буде кнопка «Відписатися» — з пробного листа нічого не змінюється.',
      }),
    };
  }

  if (oneClick) {
    store.selfUnsubscribe(target.contactId, target.projectId, { campaignId: target.campaignId || null, source: 'one_click' });
    return { status: 200, text: 'OK' };
  }

  if (method === 'POST' && body.action === 'resubscribe') {
    const result = store.selfResubscribe(target.contactId, target.projectId, { campaignId: target.campaignId || null });
    if (result === 'not_allowed') {
      return {
        status: 200,
        html: page({ school, title: 'Не вдалося повернути підписку', text: 'Цю адресу відписано на ваше прохання або вона не приймає листів. Напишіть нам — повернемо вручну.' }),
      };
    }
    return { status: 200, html: page({ school, title: 'Підписку повернуто', text: 'Дякуємо! Листи від нас знову приходитимуть на цю адресу.' }) };
  }

  if (method === 'POST') {
    const result = store.selfUnsubscribe(target.contactId, target.projectId, { campaignId: target.campaignId || null, source: 'page' });
    if (result === 'gone') {
      return { status: 200, html: page({ school, title: 'Вас немає в наших списках', text: 'Листів на цю адресу більше не буде.' }) };
    }
    return {
      status: 200,
      html: page({
        school,
        title: 'Готово, ви відписані',
        text: 'Листів від нас на цю адресу більше не буде.',
        form: { action: 'resubscribe', label: 'Я випадково — повернути підписку', quiet: true },
      }),
    };
  }

  const current = store.subscriptionState(target.contactId, target.projectId);
  if (current.state === 'gone') {
    return { status: 200, html: page({ school, title: 'Вас немає в наших списках', text: 'Листів на цю адресу більше не буде.' }) };
  }
  if (current.state === 'unsubscribed') {
    return {
      status: 200,
      html: page({
        school,
        title: 'Ви вже відписані',
        text: `Листів на ${maskEmail(current.email)} більше не буде.`,
        form: current.reason === 'unsubscribed' ? { action: 'resubscribe', label: 'Повернути підписку', quiet: true } : null,
      }),
    };
  }
  return {
    status: 200,
    html: page({
      school,
      title: 'Відписатися від листів?',
      text: `Після відписки листи на ${maskEmail(current.email)} більше не надходитимуть.`,
      form: { action: 'unsubscribe', label: 'Відписатися' },
      note: 'Передумали — просто закрийте сторінку.',
    }),
  };
}
