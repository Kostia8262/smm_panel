/**
 * Ящики-отправители: приложение Google, подключение, потолки, сторож,
 * пробное письмо (docs/рассылка.md, §8).
 *
 * Refresh-токен лежит в базе шифротекстом; access-токен (живёт час) — только
 * в памяти процесса. Веб и воркер — разные процессы, у каждого свой кэш: это
 * лишний запрос к Google раз в час, а не беда.
 */

import { db, log } from '../../db.js';
import { encrypt, decrypt } from '../../secrets.js';
import { getSetting, setSetting } from '../../staff.js';
import { getProject } from '../../projects.js';
import { SENDING } from '../specs.js';
import { MailError } from '../store.js';
import { checkAddress } from '../import/address.js';
import { buildMessage, toBase64Url } from '../compose/mime.js';
import { renderLetter, sampleBlocks } from '../compose/render.js';
import { brandFor } from '../compose/brand.js';
import { tokenFor, unsubscribeUrl, unsubscribeHeaders } from '../unsubscribe.js';
import * as googleOauth from './google-oauth.js';
import { sendRaw, GmailError } from './gmail.js';

const DAY_MS = 86400000;
const nowIso = (now = Date.now()) => new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const SENDER_STATES = {
  ok: 'работает',
  expiring: 'доступ скоро умрёт',
  dead: 'доступ отозван',
  error: 'ошибка проверки',
  unknown: 'не проверен',
  disconnected: 'отключён',
};

/* ---------------------------- приложение Google ---------------------------- */

export function googleApp() {
  const clientId = getSetting('google_client_id', '');
  const enc = getSetting('google_client_secret', '');
  let clientSecret = '';
  try {
    clientSecret = enc ? decrypt(enc) : '';
  } catch {
    clientSecret = '';
  }
  return { clientId, clientSecret, configured: Boolean(clientId && clientSecret) };
}

export function saveGoogleApp({ clientId, clientSecret }) {
  const id = String(clientId ?? '').trim();
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) {
    throw new MailError('Это не похоже на Client ID: он заканчивается на .apps.googleusercontent.com');
  }
  const secret = String(clientSecret ?? '').trim();
  if (!secret && !googleApp().clientSecret) throw new MailError('Впишите Client secret');
  setSetting('google_client_id', id);
  if (secret) setSetting('google_client_secret', encrypt(secret));
  log('info', 'рассылка: обновлены доступы приложения Google');
}

/* -------------------------------- потолки -------------------------------- */

function kindOf(email) {
  return /@(gmail|googlemail)\.com$/i.test(email) ? 'gmail' : 'workspace';
}

/**
 * Сколько писем ящик может отправить за скользящие сутки.
 * @returns {{google: number, panel: number, warmupDay: number|null, warmupCap: number|null, effective: number}}
 */
export function capOf(row, now = Date.now()) {
  const google = SENDING.googleDaily[row.kind] || SENDING.googleDaily.gmail;
  const panel = row.daily_cap ? Math.min(Number(row.daily_cap), google) : Math.floor(google * SENDING.panelShare);
  let warmupDay = null;
  let warmupCap = null;
  if (row.warmup_from) {
    warmupDay = Math.max(1, Math.floor((now - Date.parse(row.warmup_from)) / DAY_MS) + 1);
    const tier = SENDING.warmup.find(([day]) => warmupDay <= day);
    if (tier) warmupCap = tier[1];
  }
  return { google, panel, warmupDay, warmupCap, effective: warmupCap ? Math.min(panel, warmupCap) : panel };
}

/** Отправлено за последние 24 часа — считается по записям, а не полем, которое может разойтись. */
export function usage24h(senderId, now = Date.now()) {
  const since = nowIso(now - DAY_MS);
  return db.prepare('SELECT COUNT(*) AS n FROM mail_test_sends WHERE sender_id = ? AND sent_at > ?').get(senderId, since).n;
}

/* --------------------------------- ящики --------------------------------- */

function publicSender(row, now = Date.now()) {
  const cap = capOf(row, now);
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    kind: row.kind,
    kindTitle: row.kind === 'gmail' ? 'Gmail' : 'Google Workspace',
    state: row.disconnected_at ? 'disconnected' : row.state,
    stateTitle: SENDER_STATES[row.disconnected_at ? 'disconnected' : row.state] || row.state,
    lastError: row.last_error,
    checkedAt: row.checked_at,
    tokenSavedAt: row.token_saved_at,
    tokenExpiresAt: row.token_expires_at,
    windowFrom: row.window_from,
    windowTo: row.window_to,
    dailyCap: row.daily_cap,
    warmup: Boolean(row.warmup_from),
    warmupFrom: row.warmup_from,
    cap,
    sent24h: usage24h(row.id, now),
    createdAt: row.created_at,
    disconnectedAt: row.disconnected_at,
  };
}

function rowOf(id) {
  const row = db.prepare('SELECT * FROM mail_senders WHERE id = ?').get(Number(id));
  if (!row) throw new MailError('Ящик не найден', 404);
  return row;
}

export function listSenders({ includeDisconnected = false, now = Date.now() } = {}) {
  return db
    .prepare(`SELECT * FROM mail_senders ${includeDisconnected ? '' : 'WHERE disconnected_at IS NULL'} ORDER BY disconnected_at IS NOT NULL, id`)
    .all()
    .map((row) => publicSender(row, now));
}

export function getSender(id, now = Date.now()) {
  return publicSender(rowOf(id), now);
}

/**
 * Ящик подключён кнопкой. Тот же адрес подключают заново — настройки и
 * прогрев сохраняются, меняется только доступ.
 */
export function saveConnected({ email, refreshToken, scopes = [], refreshExpiresAt = null, staffId = null }, now = Date.now()) {
  const existing = db.prepare('SELECT * FROM mail_senders WHERE email = ?').get(email);
  const at = nowIso(now);
  if (existing) {
    db.prepare(
      `UPDATE mail_senders SET refresh_token_enc = ?, scopes = ?, token_saved_at = ?, token_expires_at = ?,
              state = 'ok', checked_at = ?, last_error = NULL, warned_stage = NULL, disconnected_at = NULL,
              connected_by = ? WHERE id = ?`
    ).run(encrypt(refreshToken), scopes.join(' '), at, refreshExpiresAt, at, staffId, existing.id);
    cache.delete(existing.id);
    log('info', `рассылка: ящик ${email} переподключён`);
    return getSender(existing.id, now);
  }
  const info = db
    .prepare(
      `INSERT INTO mail_senders (email, kind, refresh_token_enc, scopes, token_saved_at, token_expires_at, warmup_from,
                                 window_from, window_to, state, checked_at, connected_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`
    )
    .run(email, kindOf(email), encrypt(refreshToken), scopes.join(' '), at, refreshExpiresAt, at, SENDING.window.from, SENDING.window.to, at, staffId);
  log('info', `рассылка: подключён ящик ${email}${refreshExpiresAt ? ' — доступ временный, приложение в режиме Testing?' : ''}`);
  return getSender(info.lastInsertRowid, now);
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function updateSender(id, { displayName, dailyCap, warmup, windowFrom, windowTo }, now = Date.now()) {
  const row = rowOf(id);
  const sets = [];
  const params = [];
  if (displayName !== undefined) {
    sets.push('display_name = ?');
    params.push(String(displayName).replace(/[\r\n]+/g, ' ').trim().slice(0, 80));
  }
  if (dailyCap !== undefined) {
    const google = SENDING.googleDaily[row.kind];
    const value = dailyCap === null || dailyCap === '' ? null : Number(dailyCap);
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > google)) {
      throw new MailError(`Потолок — целое число от 1 до ${google}: больше Google не пропустит`);
    }
    sets.push('daily_cap = ?');
    params.push(value);
  }
  if (warmup !== undefined) {
    sets.push('warmup_from = ?');
    params.push(warmup ? row.warmup_from || nowIso(now) : null);
  }
  for (const [value, column] of [
    [windowFrom, 'window_from'],
    [windowTo, 'window_to'],
  ]) {
    if (value === undefined) continue;
    if (!TIME_RE.test(String(value))) throw new MailError('Время окна — в виде 08:00');
    sets.push(`${column} = ?`);
    params.push(String(value));
  }
  const from = windowFrom ?? row.window_from;
  const to = windowTo ?? row.window_to;
  if (from >= to) throw new MailError('Окно отправки должно начинаться раньше, чем заканчивается');
  if (sets.length) db.prepare(`UPDATE mail_senders SET ${sets.join(', ')} WHERE id = ?`).run(...params, row.id);
  return getSender(row.id, now);
}

export async function disconnect(id, { fetchImpl = globalThis.fetch } = {}) {
  const row = rowOf(id);
  if (row.refresh_token_enc) {
    try {
      await googleOauth.revoke(decrypt(row.refresh_token_enc), fetchImpl);
    } catch {
      // Отзыв у Google — вежливость; токен всё равно стирается у нас.
    }
  }
  db.prepare("UPDATE mail_senders SET refresh_token_enc = NULL, state = 'disconnected', disconnected_at = ? WHERE id = ?").run(nowIso(), row.id);
  cache.delete(row.id);
  log('warn', `рассылка: ящик ${row.email} отключён, доступ у Google отозван`);
}

/* ------------------------------ access-токен ------------------------------ */

const cache = new Map(); // senderId → { token, expiresAt }

function markState(row, state, error = null, now = Date.now()) {
  db.prepare('UPDATE mail_senders SET state = ?, last_error = ?, checked_at = ? WHERE id = ?').run(state, error, nowIso(now), row.id);
}

/** Действующий access-токен ящика: из памяти или свежий у Google. */
export async function accessTokenFor(id, { fetchImpl = globalThis.fetch, now = Date.now(), force = false } = {}) {
  const row = rowOf(id);
  if (row.disconnected_at || !row.refresh_token_enc) throw new MailError('Ящик отключён — подключите его заново');
  const hit = cache.get(row.id);
  if (!force && hit && hit.expiresAt - now > 60000) return hit.token;

  const app = googleApp();
  if (!app.configured) throw new MailError('Не заполнены ID и секрет приложения Google');
  try {
    const fresh = await googleOauth.refreshAccess({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      refreshToken: decrypt(row.refresh_token_enc),
      fetchImpl,
      now,
    });
    cache.set(row.id, { token: fresh.accessToken, expiresAt: fresh.accessExpiresAt });
    return fresh.accessToken;
  } catch (err) {
    if (err.kind === 'dead') markState(row, 'dead', err.message, now);
    else markState(row, 'error', err.message, now);
    throw err;
  }
}

/** Проверка ящика: получить свежий доступ и отметить состояние. */
export async function checkSender(id, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const row = rowOf(id);
  await accessTokenFor(row.id, { fetchImpl, now, force: true });
  const expiring = row.token_expires_at && Date.parse(row.token_expires_at) - now < 2 * DAY_MS;
  markState(row, expiring ? 'expiring' : 'ok', expiring ? 'Доступ временный и скоро умрёт: переведите приложение в In production и подключите ящик заново' : null, now);
  return getSender(row.id, now);
}

/**
 * Сторож ящиков — из обхода токенов в воркере, раз в шесть часов. О беде пишет
 * в журнал один раз на каждое ухудшение, а не при каждом обходе.
 */
export async function sweepSenders({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const rows = db.prepare('SELECT * FROM mail_senders WHERE disconnected_at IS NULL AND refresh_token_enc IS NOT NULL').all();
  for (const row of rows) {
    let stage = 'ok';
    let message = '';
    try {
      const fresh = await checkSender(row.id, { fetchImpl, now });
      stage = fresh.state;
      message = fresh.lastError || '';
    } catch (err) {
      stage = err.kind === 'dead' ? 'dead' : 'error';
      message = err.message;
    }
    if (stage !== 'ok' && stage !== row.warned_stage) {
      log(stage === 'dead' ? 'error' : 'warn', `рассылка: ящик ${row.email} — ${SENDER_STATES[stage]}: ${message}`);
    }
    db.prepare('UPDATE mail_senders SET warned_stage = ? WHERE id = ?').run(stage === 'ok' ? null : stage, row.id);
  }
  return rows.length;
}

/** Ящики, которым нужен владелец: для значка у пункта «Рассылка». */
export function senderAlerts() {
  const rows = db.prepare("SELECT state FROM mail_senders WHERE disconnected_at IS NULL AND state IN ('dead', 'error', 'expiring')").all();
  return { count: rows.length, worst: rows.some((r) => r.state === 'dead') ? 'danger' : rows.length ? 'warn' : null };
}

/* ------------------------------ пробное письмо ------------------------------ */

/**
 * Пробное письмо — образец фирменной вёрстки школы: сразу видно и то, что
 * ящик работает, и то, как рассылка выглядит в настоящем Gmail.
 */
function testLetter({ project, unsubscribe }) {
  const brand = brandFor(project);
  const blocks = sampleBlocks(project, brand);
  blocks.splice(1, 1, { type: 'eyebrow', text: 'Пробний лист · образець оформлення' });
  const subject = `Пробний лист — ${project.title}`;
  const { html, text } = renderLetter({
    brand,
    subject,
    preheader: 'Так виглядатиме розсилка: місця під картинки підписані розмірами.',
    blocks,
    signature: project.signature,
    reason: 'це пробний лист із панелі розсилки',
    unsubscribeUrl: unsubscribe,
  });
  return { subject, text, html };
}

/**
 * Пробное письмо: себе или на несколько своих адресов. Входит в суточный
 * счётчик ящика — Google считает его так же, как рассылку.
 *
 * @returns {Promise<{sent: {email: string, gmailId: string}[], failed: {email: string, error: string}[]}>}
 */
export async function sendTest(id, { to = [], projectId, staffId = null, publicBase, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const row = rowOf(id);
  const project = getProject(projectId);
  if (!project) throw new MailError('Не выбран проект', 400);

  const recipients = [...new Set((to.length ? to : [row.email]).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (recipients.length > SENDING.testRecipientsMax) throw new MailError(`Пробное письмо — не больше чем на ${SENDING.testRecipientsMax} адресов`);
  for (const email of recipients) {
    const check = checkAddress(email);
    if (check.verdict === 'invalid' || check.verdict === 'fixable') throw new MailError(`Адрес не подходит: ${email}`);
  }
  const cap = capOf(row, now);
  if (usage24h(row.id, now) + recipients.length > cap.effective) {
    throw new MailError(`Потолок ящика на сутки (${cap.effective}) исчерпан — пробное письмо съело бы письма рассылки`);
  }

  const token = await accessTokenFor(row.id, { fetchImpl, now });
  const fromName = row.display_name || project.title;
  const unsubscribe = unsubscribeUrl(publicBase, tokenFor({ projectId: project.id, contactId: 0, campaignId: 0 }));
  const letter = testLetter({ project, unsubscribe });

  const sent = [];
  const failed = [];
  for (const email of recipients) {
    const raw = toBase64Url(
      buildMessage({
        from: { name: fromName, email: row.email },
        to: { email },
        subject: letter.subject,
        text: letter.text,
        html: letter.html,
        headers: unsubscribeHeaders(unsubscribe),
        date: new Date(now),
      })
    );
    try {
      const out = await sendRaw({ accessToken: token, raw, fetchImpl });
      db.prepare('INSERT INTO mail_test_sends (sender_id, to_email, gmail_id, sent_by, sent_at) VALUES (?, ?, ?, ?, ?)').run(row.id, email, out.id, staffId, nowIso(now));
      sent.push({ email, gmailId: out.id });
    } catch (err) {
      if (err instanceof GmailError && err.kind === 'auth') cache.delete(row.id);
      if (err instanceof GmailError && err.kind === 'unknown') {
        // Не знаем, ушло ли: считаем в потолок, чтобы не перебрать лимит Google.
        db.prepare('INSERT INTO mail_test_sends (sender_id, to_email, gmail_id, sent_by, sent_at) VALUES (?, ?, NULL, ?, ?)').run(row.id, email, staffId, nowIso(now));
      }
      failed.push({ email, error: err.message });
    }
  }
  log(
    failed.length ? 'warn' : 'info',
    `рассылка: пробное письмо с ${row.email} — ушло ${sent.length}${failed.length ? `, не ушло ${failed.length}: ${failed[0].error}` : ''}`
  );
  return { sent, failed };
}
