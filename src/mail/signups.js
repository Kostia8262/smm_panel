/**
 * Подписка с сайтов: форма в подвале → письмо с подтверждением → база
 * «Подписка с сайта» (docs/рассылка.md, фаза 6).
 *
 * Обещания:
 *   — в базу попадает только тот, кто нажал кнопку в письме (двойное
 *     подтверждение): чужой адрес, вписанный в форму, писем не получит;
 *   — ответ формы не выдаёт, подписан ли адрес: иначе форма — способ проверять
 *     чужие адреса;
 *   — GET по ссылке из письма не подписывает (сканеры ссылок открывают всё) —
 *     подписывает кнопка на странице;
 *   — форму нельзя превратить в рассыльщик: ограничения по адресу обратившегося
 *     и по самому адресу почты, ловушка для роботов.
 */

import { createHash, randomBytes } from 'node:crypto';
import { db, log } from '../db.js';
import { getSetting, setSetting } from '../staff.js';
import { getProject } from '../projects.js';
import { parseOwnDomains } from '../shortlink.js';
import { tooManyAttempts } from '../ratelimit.js';
import { deriveKey } from '../secrets.js';
import * as store from './store.js';
import { checkAddress, maskEmail, emailHash } from './import/address.js';
import { renderLetter } from './compose/render.js';
import { brandFor } from './compose/brand.js';
import { publicPage } from './unsubscribe.js';
import * as senders from './sender/senders.js';

const DAY_MS = 86400000;
const TOKEN_TTL_MS = 7 * DAY_MS;
const nowIso = (now = Date.now()) => new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

export const SIGNUP_LIMITS = {
  perIpPerHour: 5,
  perEmailPerDay: 3,
  resendAfterMinutes: 10,
};

/** Ответ формы — один на все исходы, кроме ошибки в самом адресе. */
const ACCEPTED = 'Майже готово! Ми надіслали лист — натисніть у ньому кнопку, щоб підтвердити підписку.';

let ipKey = null;
const ipHash = (ip) => createHash('sha256').update(ipKey ||= deriveKey('mail-signup-ip')).update(String(ip || '')).digest('hex').slice(0, 32);

/** Сайт, с которого пришла форма, — только свои домены. */
export function siteOf(origin) {
  let host;
  try {
    host = new URL(String(origin || '')).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  const own = parseOwnDomains(getSetting('own_domains', 'mycomputer.education,mycomputer.school'));
  return own.some((d) => host === d || host.endsWith(`.${d}`)) ? host : null;
}

/** База «Подписка с сайта» школы — заводится при первой подписке. */
function signupList(projectId) {
  const key = `mail_signup_list_${projectId}`;
  const id = Number(getSetting(key, '0'));
  const existing = id ? store.getList(id) : null;
  if (existing && existing.projectId === projectId && !existing.archivedAt) return existing;
  const list = store.createList(projectId, { name: 'Подписка с сайта', consentBasis: 'form', description: 'Подтвердили подписку по письму' });
  setSetting(key, String(list.id));
  return list;
}

function projectBySlug(slug) {
  const row = db.prepare('SELECT id FROM projects WHERE slug = ? AND active = 1').get(String(slug || ''));
  return row ? getProject(row.id) : null;
}

function confirmLetter({ project, url }) {
  const brand = brandFor(project);
  const subject = `Підтвердіть підписку — ${brand.title}`;
  const { html, text } = renderLetter({
    brand,
    subject,
    preheader: 'Один клік — і ви отримуватимете наші листи.',
    blocks: [
      { type: 'heading', text: 'Підтвердіть підписку' },
      {
        type: 'text',
        text: 'Хтось — сподіваємося, ви — вказав цю адресу у формі підписки на нашому сайті. Натисніть кнопку, щоб отримувати листи про курси, події та корисні матеріали.',
      },
      { type: 'button', text: 'Підтвердити підписку', href: url, note: 'Якщо ви не підписувалися — просто проігноруйте цей лист, і ми більше не напишемо.' },
    ],
    signature: project.signature,
    reason: 'цю адресу вказали у формі підписки на нашому сайті',
  });
  return { subject, html, text };
}

/**
 * Приём формы.
 * @param {{email: string, school: string, origin?: string, page?: string, honeypot?: string, ip?: string, publicBase: string, fetchImpl?: Function, now?: number}} input
 * @returns {Promise<{status: number, ok: boolean, message: string, suggestion?: string}>}
 */
export async function subscribe({ email, school, origin, page = '', honeypot = '', ip = '', publicBase, fetchImpl, now = Date.now() }) {
  const site = siteOf(origin);
  if (!site) return { status: 403, ok: false, code: 'foreign_site', message: 'Форма працює лише на наших сайтах.' };
  const project = projectBySlug(school);
  if (!project) return { status: 400, ok: false, code: 'unknown_school', message: 'Не вдалося визначити школу. Оновіть сторінку.' };

  // Ловушка: поле, которого человек не видит. Роботу отвечаем как человеку.
  if (String(honeypot || '').trim()) return { status: 200, ok: true, code: 'accepted', message: ACCEPTED };

  const ipH = ipHash(ip);
  if (tooManyAttempts(`signup:${ipH}`, { limit: SIGNUP_LIMITS.perIpPerHour, windowMs: 3600000, blockMs: 3600000, now })) {
    return { status: 429, ok: false, code: 'too_many', message: 'Забагато спроб. Спробуйте за годину.' };
  }

  const check = checkAddress(email);
  if (check.verdict === 'invalid') return { status: 400, ok: false, code: 'invalid_email', message: 'Схоже, в адресі помилка. Перевірте, будь ласка.' };
  if (check.verdict === 'fixable' && check.suggestion) {
    return { status: 400, ok: false, code: 'typo', message: `Можливо, ви мали на увазі ${check.suggestion}?`, suggestion: check.suggestion };
  }
  const address = check.email;

  const recent = db
    .prepare("SELECT COUNT(*) AS n, MAX(confirm_sent_at) AS last FROM mail_signups WHERE project_id = ? AND email = ? AND created_at > ?")
    .get(project.id, address, nowIso(now - DAY_MS));
  // Уже подписан (активен и не в стоп-листе) — письмо не шлём, ответ тот же.
  const contact = db.prepare('SELECT id, status FROM mail_contacts WHERE project_id = ? AND email = ?').get(project.id, address);
  const alreadyActive = contact && contact.status === 'active' && !store.isSuppressed(project.id, address) &&
    db.prepare('SELECT 1 FROM mail_list_members WHERE contact_id = ? AND removed_at IS NULL').get(contact.id);
  const tooSoon = recent.last && now - Date.parse(recent.last) < SIGNUP_LIMITS.resendAfterMinutes * 60000;
  if (alreadyActive || tooSoon || recent.n >= SIGNUP_LIMITS.perEmailPerDay) {
    return { status: 200, ok: true, code: 'accepted', message: ACCEPTED };
  }

  const sender = senders.listSenders().find((s) => !['dead', 'disconnected'].includes(s.state));
  if (!sender) {
    log('error', `рассылка: подписка с ${site} не принята — нет живого ящика для письма-подтверждения`);
    return { status: 503, ok: false, code: 'unavailable', message: 'Підписка тимчасово не працює. Спробуйте пізніше.' };
  }

  const token = randomBytes(24).toString('base64url');
  const info = db
    .prepare('INSERT INTO mail_signups (project_id, email, token_hash, site, page, ip_hash) VALUES (?, ?, ?, ?, ?, ?)')
    .run(project.id, address, sha256(token), site, String(page || '').slice(0, 300), ipH);
  const url = `${String(publicBase).replace(/\/$/, '')}/s/confirm/${token}`;
  const letter = confirmLetter({ project, url });

  try {
    const out = await senders.sendTestMessage(sender.id, {
      to: [address],
      fromName: sender.displayName || project.title,
      subject: letter.subject,
      html: letter.html,
      text: letter.text,
      unsubscribe: null,
      label: `подтверждение подписки с ${site}`,
      fetchImpl,
      now,
    });
    if (!out.sent.length) throw new Error(out.failed[0]?.error || 'письмо не ушло');
    db.prepare('UPDATE mail_signups SET confirm_sent_at = ? WHERE id = ?').run(nowIso(now), info.lastInsertRowid);
  } catch (err) {
    db.prepare("UPDATE mail_signups SET status = 'failed', error = ? WHERE id = ?").run(String(err.message).slice(0, 300), info.lastInsertRowid);
    log('warn', `рассылка: письмо-подтверждение подписки (${maskEmail(address)}) не ушло: ${err.message}`);
    return { status: 503, ok: false, code: 'send_failed', message: 'Не вдалося надіслати лист. Спробуйте пізніше.' };
  }
  return { status: 200, ok: true, code: 'accepted', message: ACCEPTED };
}

/**
 * Страница по ссылке из письма: GET показывает кнопку, POST подписывает.
 * @returns {{status: number, html: string}}
 */
export function confirmPage({ token, method, now = Date.now() }) {
  const row = token ? db.prepare('SELECT * FROM mail_signups WHERE token_hash = ?').get(sha256(token)) : null;
  if (!row) {
    return { status: 404, html: publicPage({ title: 'Посилання не спрацювало', text: 'Можливо, його скопійовано не повністю. Підпишіться ще раз у формі на сайті.' }) };
  }
  const project = getProject(row.project_id);
  const school = project?.title || '';
  if (row.status === 'confirmed') {
    return { status: 200, html: publicPage({ school, title: 'Підписку вже підтверджено', text: 'Дякуємо! Листи надходитимуть на цю адресу.' }) };
  }
  if (row.status !== 'pending' || now - Date.parse(row.created_at) > TOKEN_TTL_MS) {
    return { status: 410, html: publicPage({ school, title: 'Посилання застаріло', text: 'Підпишіться ще раз у формі на сайті — ми надішлемо новий лист.' }) };
  }
  if (method !== 'POST') {
    return {
      status: 200,
      html: publicPage({
        school,
        title: 'Підтвердити підписку?',
        text: `Листи надходитимуть на ${maskEmail(row.email)}. Відписатися можна в будь-якому листі одним кліком.`,
        form: { action: 'confirm', label: 'Підтвердити підписку' },
      }),
    };
  }

  db.exec('BEGIN');
  try {
    const list = signupList(row.project_id);
    const contactId = store.upsertContact(row.project_id, row.email, '').id;
    store.addMembership(list.id, contactId);
    // Подтверждение подписки — новое явное согласие: снимает прежнюю отписку.
    db.prepare('DELETE FROM mail_suppressions WHERE project_id = ? AND email_hash = ?').run(row.project_id, emailHash(row.email));
    db.prepare("UPDATE mail_contacts SET status = 'active', status_note = 'подтвердил подписку на сайте', status_at = ?, updated_at = ? WHERE id = ?").run(nowIso(now), nowIso(now), contactId);
    db.prepare("INSERT INTO mail_events (project_id, contact_id, type, source, note) VALUES (?, ?, 'subscribed', 'form', ?)").run(row.project_id, contactId, row.site);
    db.prepare("UPDATE mail_signups SET status = 'confirmed', confirmed_at = ?, contact_id = ? WHERE id = ?").run(nowIso(now), contactId, row.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    log('error', `рассылка: подтверждение подписки не записалось: ${err.message}`);
    return { status: 500, html: publicPage({ school, title: 'Щось пішло не так', text: 'Спробуйте ще раз за хвилину.' }) };
  }
  log('info', `рассылка: ${maskEmail(row.email)} подтвердил подписку с ${row.site}`);
  return { status: 200, html: publicPage({ school, title: 'Готово, ви підписані', text: 'Дякуємо! Перший лист прийде, щойно в нас буде чим поділитися.' }) };
}

/** Сводка для панели: сколько подписалось с сайтов и сколько ждут подтверждения. */
export function signupStats(projectId, now = Date.now()) {
  const since = nowIso(now - 30 * DAY_MS);
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM mail_signups WHERE project_id = ? AND created_at > ? GROUP BY status').all(Number(projectId), since);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return { days: 30, confirmed: by.confirmed || 0, pending: by.pending || 0, failed: by.failed || 0 };
}
