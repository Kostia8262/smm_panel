/**
 * Отправка рассылки: расписание, снимок получателей, шаг отправщика, пауза и
 * отмена, снятие картинок (docs/рассылка.md, §10, фаза 4).
 *
 * Главное обещание — **лучше не дослать, чем прислать дважды**:
 *   — письмо захватывается строкой (`queued → sending`) до обращения к сети,
 *     и второй проход его не возьмёт;
 *   — не дождались ответа Google — `unknown`, и повторять его очередь не будет;
 *   — UNIQUE (campaign_id, email) не даст второй строки тому же адресу.
 *
 * Шаг зовёт воркер раз в несколько секунд. За шаг каждый ящик отправляет не
 * больше одного письма, и только если открыто окно, не исчерпан потолок суток
 * и прошла случайная пауза после предыдущего.
 */

import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { db, log } from '../db.js';
import { getSetting } from '../staff.js';
import { withUtm } from '../links.js';
import { parseOwnDomains, CODE_LENGTH } from '../shortlink.js';
import { SENDING, CONSENT_BASES } from './specs.js';
import { MailError, isSuppressed, markInvalid } from './store.js';
import { maskEmail } from './import/address.js';
import * as campaigns from './campaigns.js';
import * as senders from './sender/senders.js';
import { sendRaw, GmailError } from './sender/gmail.js';
import { windowState, nextGap, forecast } from './sender/throttle.js';
import { buildMessage, toBase64Url } from './compose/mime.js';
import { tokenFor, unsubscribeUrl, unsubscribeHeaders } from './unsubscribe.js';
import { MAIL_MEDIA_DIR } from './compose/media.js';
import { safeUrl } from './compose/render.js';

const MINUTE = 60000;
const nowIso = (now = Date.now()) => new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');

const publicBase = () => (process.env.PUBLIC_BASE_URL || 'http://localhost:3210').replace(/\/$/, '');

/* ------------------------------ действия людей ------------------------------ */

/**
 * Поставить утверждённое письмо в расписание. Время в прошлом или «сейчас» —
 * «Разослать сейчас», и это право только владельца, как у постов.
 *
 * @param {{at?: string|null, user: {id: number, role: string, name: string}, projectId?: number|null, now?: number}} opts
 */
export function scheduleCampaign(id, { at = null, user, projectId = null, now = Date.now() }) {
  const campaign = campaigns.getCampaign(id, projectId);
  if (campaign.status !== 'approved') throw new MailError('Запланировать можно только утверждённое письмо', 409);
  if (!campaign.approvedCurrent) throw new MailError('Письмо изменилось после утверждения — утвердите его заново', 409);
  const check = campaigns.checkCampaign(campaign);
  if (check.blockers.length) throw new MailError(`Письмо не готово: ${check.blockers[0]}`, 422);

  let when = at ? Date.parse(at) : now;
  if (Number.isNaN(when)) throw new MailError('Не понял время отправки');
  if (when > now + 60 * 24 * 3600 * 1000) throw new MailError('Дальше чем на два месяца вперёд рассылку не планируем');
  const immediate = when <= now + MINUTE;
  if (immediate && user.role !== 'owner') throw new MailError('Разослать сейчас может только владелец — выберите время', 403);
  if (immediate) when = now;

  db.prepare("UPDATE mail_campaigns SET status = 'scheduled', scheduled_at = ?, pause_reason = NULL, updated_at = ? WHERE id = ? AND status = 'approved'").run(
    nowIso(when),
    nowIso(now),
    campaign.id
  );
  log('info', `рассылка: письмо #${campaign.id} «${campaign.title}» ${immediate ? 'разослать сейчас' : `запланировано на ${nowIso(when)}`} — ${user.name}, получателей около ${check.audience.recipients}`);
  return campaigns.getCampaign(campaign.id);
}

export function unscheduleCampaign(id, { user, projectId = null, now = Date.now() }) {
  const campaign = campaigns.getCampaign(id, projectId);
  if (campaign.status !== 'scheduled') throw new MailError('Письмо не в расписании', 409);
  db.prepare("UPDATE mail_campaigns SET status = 'approved', scheduled_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'").run(nowIso(now), campaign.id);
  log('info', `рассылка: письмо #${campaign.id} снято с расписания — ${user.name}`);
  return campaigns.getCampaign(campaign.id);
}

export function pauseCampaign(id, { user = null, reason = '', projectId = null, now = Date.now() } = {}) {
  const campaign = campaigns.getCampaign(id, projectId);
  if (campaign.status !== 'sending') throw new MailError('Поставить на паузу можно только идущую рассылку', 409);
  const why = reason || (user ? `пауза — ${user.name}` : 'пауза');
  db.prepare("UPDATE mail_campaigns SET status = 'paused', pause_reason = ?, updated_at = ? WHERE id = ? AND status = 'sending'").run(why, nowIso(now), campaign.id);
  log(user ? 'info' : 'warn', `рассылка: письмо #${campaign.id} на паузе: ${why}`);
  return campaigns.getCampaign(campaign.id);
}

export function resumeCampaign(id, { user, projectId = null, now = Date.now() }) {
  const campaign = campaigns.getCampaign(id, projectId);
  if (campaign.status !== 'paused') throw new MailError('Продолжить можно только рассылку на паузе', 409);
  if (!campaign.approvedCurrent) throw new MailError('Письмо изменилось после утверждения — отмените рассылку и утвердите письмо заново', 409);
  const sender = campaign.sender;
  if (!sender || ['dead', 'disconnected'].includes(sender.state)) throw new MailError('Ящик рассылки без доступа к Gmail — подключите его заново во вкладке «Ящики»', 409);
  db.prepare("UPDATE mail_campaigns SET status = 'sending', pause_reason = NULL, updated_at = ? WHERE id = ? AND status = 'paused'").run(nowIso(now), campaign.id);
  log('info', `рассылка: письмо #${campaign.id} продолжено — ${user.name}`);
  return campaigns.getCampaign(campaign.id);
}

/** Отмена: не ушедшие письма не уйдут, ушедшие остаются в истории. */
export function cancelCampaign(id, { user, projectId = null, now = Date.now() }) {
  const campaign = campaigns.getCampaign(id, projectId);
  if (!['scheduled', 'sending', 'paused'].includes(campaign.status)) throw new MailError('Отменить можно запланированную или идущую рассылку', 409);
  db.exec('BEGIN');
  try {
    const left = db.prepare("UPDATE mail_sends SET status = 'cancelled' WHERE campaign_id = ? AND status = 'queued'").run(campaign.id).changes;
    db.prepare("UPDATE mail_campaigns SET status = 'cancelled', finished_at = ?, pause_reason = NULL, updated_at = ? WHERE id = ?").run(nowIso(now), nowIso(now), campaign.id);
    db.exec('COMMIT');
    log('warn', `рассылка: письмо #${campaign.id} отменено — ${user.name}; не ушло и не уйдёт: ${left}`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return campaigns.getCampaign(campaign.id);
}

/* ------------------------------ прогноз ------------------------------ */

/**
 * Прогноз для экрана: когда уйдёт последнее письмо и что сейчас держит
 * отправку (окно закрыто, потолок, пауза Google).
 */
export function deliveryInfo(campaign, now = Date.now()) {
  const senderRow = campaign.senderId ? db.prepare('SELECT * FROM mail_senders WHERE id = ?').get(campaign.senderId) : null;
  if (!senderRow) return { forecast: null, holdUntil: null, holdReason: null, window: null, capLeft: null };
  const cap = senders.capOf(senderRow, now).effective;
  const used = senders.usage24h(senderRow.id, now);
  const state = windowState(senderRow, now);
  const progress = campaign.progress;
  const remaining = progress ? progress.queued + progress.sending : ['approved', 'scheduled'].includes(campaign.status) ? campaigns.audience(campaign).recipients : 0;

  // Впереди в очереди того же ящика — идущие рассылки, начатые раньше.
  const ahead = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mail_sends s JOIN mail_campaigns c ON c.id = s.campaign_id
       WHERE s.sender_id = ? AND s.status IN ('queued', 'sending') AND c.status = 'sending' AND c.id != ?
         AND (c.started_at < COALESCE(?, '9999'))`
    )
    .get(senderRow.id, campaign.id, campaign.startedAt).n;

  const holdUntil = senderRow.paused_until && Date.parse(senderRow.paused_until) > now ? senderRow.paused_until : null;
  const startAt = campaign.status === 'scheduled' && campaign.scheduledAt ? Math.max(now, Date.parse(campaign.scheduledAt)) : holdUntil ? Date.parse(holdUntil) : now;
  const estimate = remaining && ['approved', 'scheduled', 'sending'].includes(campaign.status)
    ? forecast({ sender: senderRow, remaining, ahead, capLeft: startAt > now + 12 * 3600 * 1000 ? cap : cap - used, cap, now: startAt })
    : null;
  return {
    forecast: estimate ? { finishAt: nowIso(estimate.finishAt), days: estimate.days } : null,
    remaining,
    ahead,
    cap,
    used,
    capLeft: Math.max(0, cap - used),
    window: { open: state.open, from: senderRow.window_from, to: senderRow.window_to, opensAt: state.opensAt ? nowIso(state.opensAt) : null },
    holdUntil,
    holdReason: holdUntil ? senderRow.hold_reason : null,
  };
}

/* ------------------------------ снимок ------------------------------ */

/** Кому уйдёт письмо: активные адреса баз «кому», кроме баз «кроме», без стоп-листа. */
function recipientsOf(campaign) {
  const inc = campaign.lists.include.map((l) => l.id);
  const exc = campaign.lists.exclude.map((l) => l.id);
  if (!inc.length) return [];
  const rows = db
    .prepare(
      `SELECT c.id, c.email, c.name, MIN(m.list_id) AS via
       FROM mail_contacts c
       JOIN mail_list_members m ON m.contact_id = c.id AND m.removed_at IS NULL AND m.list_id IN (${inc.map(() => '?').join(',')})
       WHERE c.project_id = ? AND c.status = 'active'
         ${exc.length ? `AND NOT EXISTS (SELECT 1 FROM mail_list_members x WHERE x.contact_id = c.id AND x.removed_at IS NULL AND x.list_id IN (${exc.map(() => '?').join(',')}))` : ''}
       GROUP BY c.id ORDER BY c.id`
    )
    .all(...inc, campaign.projectId, ...exc);
  return rows.filter((r) => !isSuppressed(campaign.projectId, r.email));
}

/**
 * Короткие ссылки рассылки: одна на каждый адрес своих доменов в письме,
 * общая для всех получателей. Метки utm — чтобы заявка с сайта связалась с письмом.
 */
function buildLinkMap(campaign, now) {
  const ownDomains = parseOwnDomains(getSetting('own_domains', 'mycomputer.education,mycomputer.school'));
  const tag = `mail-${nowIso(now).slice(0, 10).replaceAll('-', '')}-c${campaign.id}`;
  const urls = new Set();
  for (const b of campaign.blocks) {
    if (safeUrl(b.href)) urls.add(b.href.trim());
    for (const text of [b.text, b.note, ...(b.items || [])]) {
      for (const m of String(text || '').matchAll(/\]\(([^)\s]+)\)/g)) if (safeUrl(m[1])) urls.add(m[1]);
    }
  }
  const map = {};
  for (const url of urls) {
    let host;
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (!ownDomains.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    const target = withUtm(url, { source: 'email', medium: 'email', campaign: tag, content: 'email' });
    if (!target) continue;
    const code = randomBytes(5).toString('base64url');
    if (code.length !== CODE_LENGTH) continue;
    db.prepare("INSERT INTO links (code, project_id, post_id, platform, target_url, campaign, mail_campaign_id) VALUES (?, ?, NULL, 'email', ?, ?, ?)").run(
      code,
      campaign.projectId,
      target,
      tag,
      campaign.id
    );
    map[url] = `${publicBase()}/r/${code}`;
  }
  return map;
}

/** Старт созревших рассылок: снимок получателей одной транзакцией. */
export function startDue(now = Date.now()) {
  const due = db.prepare("SELECT id FROM mail_campaigns WHERE status = 'scheduled' AND deleted_at IS NULL AND scheduled_at <= ? ORDER BY scheduled_at, id").all(nowIso(now));
  const started = [];
  for (const { id } of due) {
    const campaign = campaigns.getCampaign(id);
    const row = campaigns.campaignRow(id);
    if (row.approved_hash !== row.content_hash) {
      db.prepare("UPDATE mail_campaigns SET status = 'approved', scheduled_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(now), id);
      log('error', `рассылка: письмо #${id} не стартовало — содержимое разошлось с утверждённым`);
      continue;
    }
    if (!campaign.sender) {
      db.prepare("UPDATE mail_campaigns SET status = 'paused', started_at = ?, pause_reason = ? WHERE id = ?").run(nowIso(now), 'не выбран ящик', id);
      continue;
    }
    db.exec('BEGIN');
    let count = 0;
    try {
      const claimed = db.prepare("UPDATE mail_campaigns SET status = 'sending', started_at = ?, pause_reason = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'").run(nowIso(now), nowIso(now), id);
      if (claimed.changes !== 1) {
        db.exec('ROLLBACK');
        continue;
      }
      const insert = db.prepare(
        'INSERT OR IGNORE INTO mail_sends (campaign_id, sender_id, contact_id, email, name, via_list_id, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      // Частота школы: недавно получавшие письмо остаются в снимке пропущенными — видно, кому и почему не ушло.
      const gapDays = campaigns.frequencyGapDays(campaign.projectId);
      const recent = gapDays ? db.prepare(`SELECT 1 FROM mail_contacts c WHERE c.id = ? AND ${campaigns.RECENT_SQL}`) : null;
      const since = gapDays ? campaigns.recentSince(gapDays, now) : null;
      for (const r of recipientsOf(campaign)) {
        const skip = recent && recent.get(r.id, campaign.projectId, id, since);
        const info = insert.run(id, campaign.sender.id, r.id, r.email, r.name || '', r.via, skip ? 'skipped' : 'queued', skip ? `получал письмо школы меньше ${gapDays} дн. назад` : null);
        if (!skip) count += info.changes;
      }
      db.prepare('UPDATE mail_campaigns SET link_map = ? WHERE id = ?').run(JSON.stringify(buildLinkMap(campaign, now)), id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      log('error', `рассылка: письмо #${id} не стартовало: ${err.message}`);
      continue;
    }
    log('info', `рассылка: письмо #${id} «${campaign.title}» — старт, получателей ${count}`);
    started.push(id);
  }
  return started;
}

/* ------------------------------ сборка ------------------------------ */

function applyLinks(blocks, map) {
  if (!map || !Object.keys(map).length) return blocks;
  const swapText = (text) => (text ? String(text).replace(/\]\(([^)\s]+)\)/g, (whole, url) => (map[url] ? `](${map[url]})` : whole)) : text);
  return blocks.map((b) => ({
    ...b,
    href: b.href && map[b.href.trim()] ? map[b.href.trim()] : b.href,
    text: swapText(b.text),
    note: swapText(b.note),
    items: b.items ? b.items.map(swapText) : b.items,
  }));
}

const listBasis = new Map();

function reasonFor(listId) {
  if (!listBasis.has(listId)) listBasis.set(listId, db.prepare('SELECT consent_basis FROM mail_lists WHERE id = ?').get(listId)?.consent_basis || 'other');
  return (CONSENT_BASES[listBasis.get(listId)] || CONSENT_BASES.other).footer;
}

function messageFor(campaign, row, send, senderRow, now) {
  const map = row.link_map ? JSON.parse(row.link_map) : {};
  const unsubscribe = unsubscribeUrl(publicBase(), tokenFor({ projectId: campaign.projectId, contactId: send.contact_id, campaignId: campaign.id }));
  const built = campaigns.buildLetter(
    { ...campaign, blocks: applyLinks(campaign.blocks, map) },
    { mode: 'send', vars: { name: send.name }, unsubscribeUrl: unsubscribe, reason: send.via_list_id ? reasonFor(send.via_list_id) : null }
  );
  if (built.missingImages.length) return { missing: built.missingImages };
  const raw = toBase64Url(
    buildMessage({
      from: { name: built.fromName, email: senderRow.email },
      to: { name: send.name, email: send.email },
      subject: built.subject,
      text: built.text,
      html: built.html,
      inline: built.inline,
      replyTo: campaign.replyTo,
      headers: unsubscribeHeaders(unsubscribe),
      date: new Date(now),
    })
  );
  return { raw };
}

/* ------------------------------ шаг ------------------------------ */

const nextAt = new Map(); // senderId → когда можно следующее письмо
let running = false;
let purgedAt = 0;

function pauseSenderCampaigns(senderId, reason, now) {
  const rows = db.prepare("SELECT DISTINCT campaign_id AS id FROM mail_sends WHERE sender_id = ? AND status = 'queued'").all(senderId);
  for (const { id } of rows) {
    const changed = db.prepare("UPDATE mail_campaigns SET status = 'paused', pause_reason = ?, updated_at = ? WHERE id = ? AND status = 'sending'").run(reason, nowIso(now), id).changes;
    if (changed) log('error', `рассылка: письмо #${id} на паузе: ${reason}`);
  }
}

function holdSender(senderRow, until, reason) {
  db.prepare('UPDATE mail_senders SET paused_until = ?, hold_reason = ? WHERE id = ?').run(nowIso(until), reason, senderRow.id);
  log('warn', `рассылка: ящик ${senderRow.email} придержан до ${nowIso(until)}: ${reason}`);
}

function release(sendId, { notBefore = null, error = null } = {}) {
  db.prepare("UPDATE mail_sends SET status = 'queued', sending_since = NULL, not_before = ?, error = ? WHERE id = ? AND status = 'sending'").run(notBefore ? nowIso(notBefore) : null, error, sendId);
}

/** Одно письмо одного ящика — если сейчас можно. @returns {string} что произошло: для тестов и журнала отладки */
async function stepSender(senderId, { now, fetchImpl }) {
  const senderRow = db.prepare('SELECT * FROM mail_senders WHERE id = ?').get(senderId);
  if (!senderRow || senderRow.disconnected_at || senderRow.state === 'dead') {
    pauseSenderCampaigns(senderId, `ящик ${senderRow?.email || ''} без доступа к Gmail — подключите его заново`, now);
    return 'dead';
  }
  if (senderRow.paused_until && Date.parse(senderRow.paused_until) > now) return 'hold';
  if ((nextAt.get(senderId) || 0) > now) return 'gap';
  if (!windowState(senderRow, now).open) return 'window';
  if (senders.usage24h(senderId, now) >= senders.capOf(senderRow, now).effective) return 'cap';

  const send = db
    .prepare(
      `SELECT s.* FROM mail_sends s JOIN mail_campaigns c ON c.id = s.campaign_id
       WHERE s.sender_id = ? AND s.status = 'queued' AND c.status = 'sending' AND c.deleted_at IS NULL
         AND (s.not_before IS NULL OR s.not_before <= ?)
       ORDER BY c.started_at, c.id, s.id LIMIT 1`
    )
    .get(senderId, nowIso(now));
  if (!send) return 'idle';

  const row = campaigns.campaignRow(send.campaign_id);
  if (row.approved_hash !== row.content_hash) {
    pauseCampaign(row.id, { reason: 'содержимое письма разошлось с утверждённым', now });
    return 'hash';
  }
  const campaign = campaigns.getCampaign(row.id);

  // Человек мог отписаться от вчерашнего письма — сверяем в момент отправки.
  const contact = send.contact_id ? db.prepare('SELECT status FROM mail_contacts WHERE id = ?').get(send.contact_id) : null;
  if (!contact || contact.status !== 'active' || isSuppressed(campaign.projectId, send.email)) {
    db.prepare("UPDATE mail_sends SET status = 'skipped', error = ? WHERE id = ? AND status = 'queued'").run(!contact ? 'контакт стёрт' : 'отписался или адрес не принимает письма', send.id);
    return 'skipped';
  }

  // Захват: дальше — только если строку взяли мы.
  const claimed = db.prepare("UPDATE mail_sends SET status = 'sending', sending_since = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'").run(nowIso(now), send.id);
  if (claimed.changes !== 1) return 'raced';
  nextAt.set(senderId, now + nextGap());

  let message;
  try {
    message = messageFor(campaign, row, send, senderRow, now);
  } catch (err) {
    release(send.id, { error: err.message });
    pauseCampaign(row.id, { reason: `письмо не собралось: ${err.message}`, now });
    return 'build';
  }
  if (message.missing) {
    release(send.id);
    pauseCampaign(row.id, { reason: `нет файла картинки: ${message.missing.join(', ')}`, now });
    return 'build';
  }

  let token;
  try {
    token = await senders.accessTokenFor(senderId, { fetchImpl, now });
  } catch (err) {
    release(send.id);
    if (err.kind === 'dead') pauseSenderCampaigns(senderId, `ящик ${senderRow.email} потерял доступ к Gmail: ${err.message}`, now);
    else nextAt.set(senderId, now + 5 * MINUTE);
    return 'token';
  }

  let out;
  try {
    out = await sendRaw({ accessToken: token, raw: message.raw, fetchImpl });
  } catch (err) {
    if (!(err instanceof GmailError) || err.kind !== 'auth') return outcomeOfError(err, { send, senderRow, campaign, now });
    // 401: access-токен истёк раньше срока — письмо точно не ушло, один раз берём свежий.
    try {
      token = await senders.accessTokenFor(senderId, { fetchImpl, now, force: true });
    } catch (authErr) {
      release(send.id, { error: authErr.message });
      if (authErr.kind === 'dead') pauseSenderCampaigns(senderId, `ящик ${senderRow.email} потерял доступ к Gmail: ${authErr.message}`, now);
      else nextAt.set(senderId, now + 5 * MINUTE);
      return 'token';
    }
    try {
      out = await sendRaw({ accessToken: token, raw: message.raw, fetchImpl });
    } catch (retryErr) {
      return outcomeOfError(retryErr, { send, senderRow, campaign, now });
    }
  }

  db.prepare("UPDATE mail_sends SET status = 'sent', sent_at = ?, gmail_id = ?, error = NULL WHERE id = ?").run(nowIso(now), out.id, send.id);
  finishIfDone(row.id, now);
  return 'sent';
}

/** Ответ Google с ошибкой → судьба письма и рассылки (§8.5). */
function outcomeOfError(err, { send, senderRow, campaign, now }) {
  // Не ошибка Google (сбой в нашем коде после отправки запроса) — судьба неизвестна.
  const kind = err instanceof GmailError ? err.kind : 'unknown';
  const message = String(err.message || err).slice(0, 300);
  switch (kind) {
    case 'rate':
    case 'daily': {
      release(send.id, { error: message });
      const retry = err.retryAt ? Date.parse(err.retryAt) : NaN;
      const until = Number.isNaN(retry) ? now + (kind === 'daily' ? 24 * 60 : SENDING.rateHoldMinutes) * MINUTE : retry;
      holdSender(senderRow, until, message);
      return kind;
    }
    case 'recipient': {
      db.prepare("UPDATE mail_sends SET status = 'failed', error = ?, sending_since = NULL WHERE id = ?").run(message, send.id);
      if (send.contact_id) markInvalid(send.contact_id, message);
      finishIfDone(campaign.id, now);
      return 'failed';
    }
    case 'temporary': {
      if (send.attempts + 1 >= SENDING.temporaryAttempts) {
        db.prepare("UPDATE mail_sends SET status = 'failed', error = ?, sending_since = NULL WHERE id = ?").run(message, send.id);
        finishIfDone(campaign.id, now);
        return 'failed';
      }
      release(send.id, { notBefore: now + (send.attempts + 1) * 2 * MINUTE, error: message });
      return 'retry';
    }
    case 'dead':
    case 'auth':
    case 'config':
    case 'rejected': {
      // Google отказал ящику, а не адресу: дальше слать нельзя, пока не разберётся человек.
      release(send.id, { error: message });
      pauseSenderCampaigns(senderRow.id, `Google отказал ящику ${senderRow.email}: ${message}`, now);
      return 'rejected';
    }
    default: {
      db.prepare("UPDATE mail_sends SET status = 'unknown', sent_at = sending_since, error = ? WHERE id = ?").run(message, send.id);
      log('warn', `рассылка: письмо #${campaign.id} на ${maskEmail(send.email)} — судьба неизвестна, повторять не будем: ${message}`);
      finishIfDone(campaign.id, now);
      return 'unknown';
    }
  }
}

function finishIfDone(campaignId, now) {
  const left = db.prepare("SELECT COUNT(*) AS n FROM mail_sends WHERE campaign_id = ? AND status IN ('queued', 'sending')").get(campaignId).n;
  if (left) return false;
  const changed = db.prepare("UPDATE mail_campaigns SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'").run(nowIso(now), nowIso(now), campaignId).changes;
  if (changed) {
    const p = campaigns.progressOf(campaignId) || {};
    log(
      p.failed || p.unknown ? 'warn' : 'info',
      `рассылка: письмо #${campaignId} разослано — ушло ${p.sent || 0}${p.failed ? `, не ушло ${p.failed}` : ''}${p.skipped ? `, пропущено ${p.skipped}` : ''}${p.unknown ? `, судьба неизвестна ${p.unknown}` : ''}`
    );
  }
  return Boolean(changed);
}

/** Захваченные письма без итога: процесс умер между отправкой и записью. Повтора нет. */
export function recoverStuck(now = Date.now()) {
  const stuck = db
    .prepare("UPDATE mail_sends SET status = 'unknown', sent_at = sending_since, error = 'отправщик прервался, не дождавшись ответа Google' WHERE status = 'sending' AND sending_since < ?")
    .run(nowIso(now - SENDING.stuckMinutes * MINUTE)).changes;
  if (stuck) log('warn', `рассылка: писем с неизвестной судьбой после сбоя отправщика: ${stuck} — повторять не будем`);
  return stuck;
}

/**
 * Картинки завершённых и убранных писем — с диска, когда их не держит ни одно
 * живое письмо: **копия делит файл с оригиналом**. Строка остаётся с `purged_at`.
 */
export function purgeMedia(now = Date.now()) {
  const before = nowIso(now - SENDING.purgeAfterMinutes * MINUTE);
  const names = db
    .prepare(
      `SELECT DISTINCT m.stored_name FROM mail_media m JOIN mail_campaigns c ON c.id = m.campaign_id
       WHERE m.purged_at IS NULL
         AND ((c.status IN ('done', 'cancelled') AND c.finished_at < ?) OR (c.deleted_at IS NOT NULL AND c.deleted_at < ?))
         AND NOT EXISTS (
           SELECT 1 FROM mail_media m2 JOIN mail_campaigns c2 ON c2.id = m2.campaign_id
           WHERE m2.stored_name = m.stored_name AND m2.purged_at IS NULL AND c2.deleted_at IS NULL
             AND c2.status NOT IN ('done', 'cancelled'))`
    )
    .all(before, before)
    .map((r) => r.stored_name);
  for (const name of names) {
    const path = resolve(MAIL_MEDIA_DIR, basename(name));
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      log('warn', `рассылка: не снялась картинка ${name}: ${err.message}`);
      continue;
    }
    db.prepare('UPDATE mail_media SET purged_at = ? WHERE stored_name = ? AND purged_at IS NULL').run(nowIso(now), name);
  }
  if (names.length) log('info', `рассылка: сняты картинки разосланных писем: ${names.length}`);
  return names.length;
}

/**
 * Шаг отправщика — из воркера. Свой флаг занятости: долгий ответ Google не
 * запускает второй шаг внахлёст.
 */
export async function mailStep({ now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  if (running) return { busy: true };
  running = true;
  try {
    recoverStuck(now);
    const started = startDue(now);
    const results = {};
    const ids = db
      .prepare("SELECT DISTINCT s.sender_id AS id FROM mail_sends s JOIN mail_campaigns c ON c.id = s.campaign_id WHERE c.status = 'sending' AND s.status = 'queued'")
      .all()
      .map((r) => r.id);
    for (const id of ids) results[id] = await stepSender(id, { now, fetchImpl });
    // Рассылка, где все письма пропущены при старте или отменены отпиской, закрывается сама.
    for (const { id } of db.prepare("SELECT id FROM mail_campaigns WHERE status = 'sending'").all()) finishIfDone(id, now);
    if (now - purgedAt > MINUTE) {
      purgedAt = now;
      purgeMedia(now);
    }
    return { started, results };
  } finally {
    running = false;
  }
}

/** Для тестов: забыть паузы между письмами. */
export function resetPacing() {
  nextAt.clear();
}
