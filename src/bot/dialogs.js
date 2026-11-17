/**
 * Переписка бота: диалоги, сообщения, план ответа и его отправка
 * (docs/бот.md, §5a и §5b).
 *
 * Разделение труда:
 *   - вебхук (`ingest`) только записывает: сообщение, состояние диалога и
 *     план «ответить в момент T». Никаких ожиданий и вызовов Meta — Meta ждёт
 *     быстрый 200 и иначе повторит доставку;
 *   - воркер (`runDue`, раз в 2 секунды) забирает созревшие планы, под
 *     `BEGIN IMMEDIATE` перечитывает диалог, выбирает ответ и шлёт.
 *
 * Своё сообщение от человеческого отличаем по `mid` (таблица `bot_sent_mids`).
 * Echo с незнакомым mid — писал человек, и диалог дальше его.
 */

import { db, log } from '../db.js';
import { listProjects, credentialsFor } from '../projects.js';
import * as knowledge from './knowledge.js';
import * as replies from './replies.js';
import { chooseReply, parseAges, STEP, WAITING_STEPS } from './funnel.js';
import { sendText, SendError } from './send.js';
import { createLead } from './crm-lead.js';

const HOUR = 3600 * 1000;
export const WINDOW_MS = 24 * HOUR;
/** Напоминания (Figma, «Таблиця реакцій»): через 2 часа и через сутки — но в окне. */
export const REMIND_FIRST_MS = 2 * HOUR;
export const REMIND_SECOND_MS = 24 * HOUR;
/** Последнее напоминание уходит не позже чем за час до конца окна. */
export const WINDOW_MARGIN_MS = HOUR;

const iso = (d = new Date()) => new Date(d).toISOString();
const ms = (s) => (s ? Date.parse(s) : 0);
/** Позднее из двух отметок: запоздавшее событие Meta не двигает время назад. */
const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
/** Сколько «в полёте» может висеть исходящее, прежде чем его сочтут потерянным. */
export const SENDING_STALE_MS = 2 * 60 * 1000;

/* ------------------------------ аккаунт → проект ------------------------------ */

/**
 * Какой проект владеет аккаунтом, на который пришло событие.
 *
 * Instagram (object = instagram) узнаём по `userId` карточки Instagram,
 * Messenger (object = page) — по `pageId` карточки Facebook. Академия и
 * школа дизайна пока сидят под одним Instagram (docs/бот.md, §2): тогда
 * берётся проект с включённым ботом, при равенстве — первый по порядку.
 */
export function projectForAccount(object, accountId) {
  const id = String(accountId);
  const hits = [];
  for (const p of listProjects()) {
    const creds = object === 'instagram' ? credentialsFor(p.id, 'instagram') : credentialsFor(p.id, 'facebook');
    const own = object === 'instagram' ? creds.userId : creds.pageId;
    if (own && String(own) === id) hits.push(p);
  }
  if (!hits.length) return null;
  const enabled = hits.find((p) => knowledge.settings(p.id).enabled);
  return (enabled || hits[0]).id;
}

/** Секреты приложения Meta, которыми может быть подписан вебхук. */
export function appSecrets() {
  const out = new Set();
  if (process.env.META_APP_SECRET) out.add(process.env.META_APP_SECRET);
  for (const p of listProjects({ includeInactive: true })) {
    const s = credentialsFor(p.id, 'facebook').appSecret;
    if (s) out.add(s);
  }
  return [...out];
}

/* ---------------------------------- диалоги ---------------------------------- */

export function getDialogRow(id) {
  return db.prepare('SELECT * FROM bot_dialogs WHERE id = ?').get(id) || null;
}

function upsertDialog(projectId, channel, accountId, peerId) {
  db.prepare(
    `INSERT INTO bot_dialogs (project_id, channel, account_id, peer_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel, account_id, peer_id) DO NOTHING`
  ).run(projectId, channel, String(accountId), String(peerId));
  return db
    .prepare('SELECT * FROM bot_dialogs WHERE channel = ? AND account_id = ? AND peer_id = ?')
    .get(channel, String(accountId), String(peerId));
}

const ALLOWED = new Set([
  'handled_by', 'human_at', 'human_by', 'last_customer_at', 'last_message_at', 'last_bot_at', 'lang', 'step',
  'child_age', 'contact_name', 'phone', 'preferred_time', 'tags', 'reprompted', 'reminders_sent', 'unread',
  'attention', 'draft_text', 'lead_status', 'lead_id', 'lead_error',
]);

export function patchDialog(id, patch) {
  const keys = Object.keys(patch).filter((k) => ALLOWED.has(k) && patch[k] !== undefined);
  if (!keys.length) return;
  db.prepare(`UPDATE bot_dialogs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => patch[k]),
    iso(),
    id
  );
}

function insertMessage({ dialogId, direction, mid, text, source, staffId = null, meta = null, sentAt }) {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO bot_messages (dialog_id, direction, mid, text, source, staff_id, meta, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(dialogId, direction, mid || null, text || '', source, staffId, meta ? JSON.stringify(meta) : null, sentAt);
  return info.changes > 0;
}

function cancelPending(dialogId, reason) {
  db.prepare(
    "UPDATE bot_reply_plans SET status = 'cancelled', reason = ?, updated_at = ? WHERE dialog_id = ? AND status = 'pending'"
  ).run(reason, iso(), dialogId);
}

/**
 * Запланировать ответ. Есть план — сдвигаем его время: клиент дописывает
 * очередью («Вітаю», «скільки коштує», «дитині 8»), и ответ должен быть один,
 * на всю очередь (§5a, склейка). Напоминание при этом превращается в ответ.
 */
function schedule(dialogId, sendAt, kind = 'reply') {
  const pending = db.prepare("SELECT id FROM bot_reply_plans WHERE dialog_id = ? AND status = 'pending'").get(dialogId);
  if (pending) {
    db.prepare('UPDATE bot_reply_plans SET send_at = ?, kind = ?, updated_at = ? WHERE id = ?').run(sendAt, kind, iso(), pending.id);
    return pending.id;
  }
  return Number(
    db.prepare('INSERT INTO bot_reply_plans (dialog_id, kind, send_at) VALUES (?, ?, ?)').run(dialogId, kind, sendAt).lastInsertRowid
  );
}

/* ---------------------------------- вебхук ---------------------------------- */

/**
 * Разобрать тело вебхука Meta и записать всё в базу. Синхронно и быстро:
 * только SQLite, без сети.
 *
 * В журнал не попадает ничего личного: ни текстов, ни id собеседников.
 *
 * @returns {{messages: number, echoes: number, duplicates: number, skipped: number, comments: number}}
 */
export function ingest(body, { now = new Date() } = {}) {
  const stats = { messages: 0, echoes: 0, duplicates: 0, skipped: 0, comments: 0 };
  const object = body?.object;
  if (object !== 'instagram' && object !== 'page') {
    stats.skipped += 1;
    return stats;
  }
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    // Комментарии — фаза 3. Пока только считаем, что они приходят.
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (['comments', 'feed', 'mentions'].includes(change?.field)) stats.comments += 1;
    }
    for (const ev of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const r = ingestMessaging(object, entry.id, ev, now);
      stats[r] = (stats[r] || 0) + 1;
    }
  }
  if (stats.comments) log('info', `бот: пришло событий комментариев — ${stats.comments} (разбор в фазе 3)`);
  return stats;
}

function ingestMessaging(object, entryId, ev, now) {
  const msg = ev?.message;
  if (!msg || !msg.mid) return 'skipped'; // прочтения, доставки, реакции
  if (msg.is_deleted || msg.is_unsupported) return 'skipped';
  const echo = Boolean(msg.is_echo);
  const accountId = String(echo ? ev.sender?.id : ev.recipient?.id || entryId || '');
  const peerId = String(echo ? ev.recipient?.id : ev.sender?.id || '');
  if (!accountId || !peerId) return 'skipped';
  const projectId = projectForAccount(object, accountId) ?? projectForAccount(object, entryId);
  if (!projectId) return 'skipped';
  const channel = object === 'instagram' ? 'direct' : 'messenger';
  const at = Number.isFinite(ev.timestamp) ? iso(ev.timestamp) : iso(now);
  const text = typeof msg.text === 'string' ? msg.text : '';
  const meta = msg.attachments ? { attachments: msg.attachments.map((a) => a?.type || 'file') } : null;

  db.exec('BEGIN IMMEDIATE');
  try {
    const dialog = upsertDialog(projectId, channel, accountId, peerId);
    const result = echo ? onEcho(dialog, { mid: msg.mid, text, at, meta }) : onCustomer(dialog, { mid: msg.mid, text, at, meta, now });
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function onCustomer(dialog, { mid, text, at, meta, now }) {
  if (!insertMessage({ dialogId: dialog.id, direction: 'in', mid, text, source: 'customer', meta, sentAt: at })) return 'duplicates';
  const cfg = knowledge.settings(dialog.project_id);
  const patch = {
    last_customer_at: later(dialog.last_customer_at, at),
    last_message_at: later(dialog.last_message_at, at),
    unread: (dialog.unread || 0) + 1,
  };

  // Возврат боту по тишине — настройка, по умолчанию выключена (§5a).
  let handledBy = dialog.handled_by;
  if (handledBy === 'human' && cfg.dialogClosedDays > 0) {
    const quiet = ms(at) - ms(dialog.last_message_at);
    if (quiet >= cfg.dialogClosedDays * 24 * HOUR) {
      Object.assign(patch, { handled_by: 'bot', step: STEP.start, attention: null, reminders_sent: 0, reprompted: 0, tags: '' });
      handledBy = 'bot';
    }
  }
  patchDialog(dialog.id, patch);

  if (handledBy !== 'bot') return 'messages';
  if (!cfg.enabled || !cfg.channels.includes(dialog.channel)) return 'messages';
  const sendAt = iso(ms(iso(now)) + cfg.replyDelaySec * 1000);
  schedule(dialog.id, sendAt, 'reply');
  return 'messages';
}

/**
 * Echo — копия сообщения, отправленного от имени аккаунта.
 *
 * Наш mid — записываем (если ещё не записали при отправке). Незнакомый —
 * писал человек: телефон, Business Suite или встроенный автоответ Meta.
 * Гонка: echo может прийти раньше, чем Send API вернул нам mid. Поэтому
 * сообщение того же текста при плане в состоянии «отправляется» — тоже наше.
 */
function onEcho(dialog, { mid, text, at, meta }) {
  const known = db.prepare('SELECT source FROM bot_sent_mids WHERE mid = ?').get(mid);
  if (known) {
    insertMessage({ dialogId: dialog.id, direction: 'out', mid, text, source: known.source, sentAt: at });
    return 'echoes';
  }
  // Автоответ, черновик и ответ из панели перед вызовом Send API лежат
  // планом «sending» с текстом — по нему и узнаётся ранний echo.
  const sending = db
    .prepare("SELECT id, kind FROM bot_reply_plans WHERE dialog_id = ? AND status = 'sending' AND text = ? ORDER BY id DESC")
    .get(dialog.id, text);
  if (sending) {
    const source = sending.kind === 'human' ? 'human' : 'bot';
    db.prepare('INSERT OR IGNORE INTO bot_sent_mids (mid, dialog_id, source) VALUES (?, ?, ?)').run(mid, dialog.id, source);
    insertMessage({ dialogId: dialog.id, direction: 'out', mid, text, source, sentAt: at });
    return 'echoes';
  }
  if (!insertMessage({ dialogId: dialog.id, direction: 'out', mid, text, source: 'human', meta, sentAt: at })) return 'duplicates';
  patchDialog(dialog.id, { handled_by: 'human', human_at: later(dialog.human_at, at), last_message_at: later(dialog.last_message_at, at), unread: 0, draft_text: null, attention: null });
  cancelPending(dialog.id, 'ответил человек');
  return 'echoes';
}

/* ---------------------------------- воркер ---------------------------------- */

/** Сообщения клиента после нашего последнего ответа — их и разбираем вместе. */
function pendingCustomerText(dialogId) {
  const lastOut = db.prepare("SELECT MAX(id) AS id FROM bot_messages WHERE dialog_id = ? AND direction = 'out'").get(dialogId).id || 0;
  return db
    .prepare("SELECT text FROM bot_messages WHERE dialog_id = ? AND direction = 'in' AND id > ? ORDER BY id")
    .all(dialogId, lastOut)
    .map((r) => r.text)
    .filter(Boolean)
    .join('\n');
}

function sayFor(projectId) {
  return (key, vars = {}) => replies.text(projectId, key, vars.lang || 'uk', vars);
}

/** Захватить план: проверки под блокировкой, чтобы два воркера не отправили дважды. */
function claim(planId, now) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const plan = db.prepare("SELECT * FROM bot_reply_plans WHERE id = ? AND status = 'pending'").get(planId);
    if (!plan || plan.send_at > iso(now)) {
      db.exec('COMMIT');
      return null;
    }
    const dialog = getDialogRow(plan.dialog_id);
    const cfg = knowledge.settings(dialog.project_id);
    let cancel = null;
    if (dialog.handled_by !== 'bot') cancel = 'диалог ведёт человек';
    else if (!cfg.enabled) cancel = 'бот выключен';
    else if (!cfg.channels.includes(dialog.channel)) cancel = 'канал выключен';
    if (cancel) {
      db.prepare("UPDATE bot_reply_plans SET status = 'cancelled', reason = ?, updated_at = ? WHERE id = ?").run(cancel, iso(), planId);
      db.exec('COMMIT');
      return null;
    }
    db.prepare("UPDATE bot_reply_plans SET status = 'sending', updated_at = ? WHERE id = ?").run(iso(), planId);
    db.exec('COMMIT');
    return { plan, dialog, cfg };
  } catch (err) {
    db.exec('ROLLBACK');
    // Другое исходящее этого диалога ещё «в полёте» — план подождёт тика.
    if (/UNIQUE/i.test(err.message)) return null;
    throw err;
  }
}

function finishPlan(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE bot_reply_plans SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    iso(),
    id
  );
}

/** Записать отправленное ботом и сдвинуть диалог по воронке. */
function recordBotSend(dialog, { mid, text, patch, handoff, sentAt, source = 'bot', staffId = null, meta = null }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO bot_sent_mids (mid, dialog_id, source) VALUES (?, ?, ?)').run(mid, dialog.id, source);
    // Echo мог прийти раньше нас и уже лечь сообщением — тогда INSERT молча пропустит.
    insertMessage({ dialogId: dialog.id, direction: 'out', mid, text, source, staffId, meta, sentAt });
    const fresh = getDialogRow(dialog.id);
    const next = { ...patch, last_bot_at: sentAt, last_message_at: later(fresh.last_message_at, sentAt), draft_text: null };
    if (handoff && fresh.handled_by === 'bot') Object.assign(next, { handled_by: 'human', attention: handoff });
    patchDialog(dialog.id, next);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Захватить запись заявки: условный UPDATE в базе, а не проверка в коде.
 * Три нажатия «Повторить заявку» подряд слали три заявки в CRM (проверка
 * 17.11): теперь идёт одно, остальным захват не достаётся.
 */
function claimLead(dialogId) {
  const info = db
    .prepare(
      `UPDATE bot_dialogs SET lead_status = 'sending', updated_at = ?
        WHERE id = ? AND phone IS NOT NULL
          AND (lead_status IS NULL OR lead_status IN ('failed', 'no_access')
               OR (lead_status = 'sending' AND updated_at < ?))`
    )
    .run(iso(), dialogId, iso(Date.now() - SENDING_STALE_MS));
  return info.changes > 0;
}

async function maybeLead(dialogId) {
  if (!claimLead(dialogId)) return false;
  const d = getDialogRow(dialogId);
  const r = await createLead(d);
  patchDialog(dialogId, { lead_status: r.status, lead_id: r.id ?? null, lead_error: r.error ?? null });
  if (r.status === 'sent') log('info', `бот: заявка из диалога #${dialogId} записана в CRM школы`);
  else log('warn', `бот: заявка из диалога #${dialogId} не записана — ${r.error}`);
  return true;
}

/**
 * Обработать один созревший план.
 * @returns {Promise<string>} итог: sent | draft | handoff | skipped | cancelled | failed | silent
 */
export async function processPlan(planId, { now = new Date() } = {}) {
  const got = claim(planId, now);
  if (!got) return 'cancelled';
  const { plan, cfg } = got;
  let dialog = got.dialog;

  // Окно 24 часа от последнего сообщения клиента: вне окна бот не пишет.
  if (!dialog.last_customer_at || ms(iso(now)) - ms(dialog.last_customer_at) >= WINDOW_MS) {
    finishPlan(plan.id, { status: 'skipped', reason: 'окно 24 часа закрыто' });
    if (plan.kind === 'reply') patchDialog(dialog.id, { attention: 'окно 24 часа закрыто — ответить может только человек' });
    return 'skipped';
  }

  const result = chooseReply({
    dialog,
    kind: plan.kind,
    text: plan.kind === 'reply' ? pendingCustomerText(dialog.id) : '',
    entries: knowledge.liveEntries(dialog.project_id),
    settings: cfg,
    channel: dialog.channel,
    say: sayFor(dialog.project_id),
  });

  // Нечего отправлять: молчим или передаём человеку.
  if (!result.text) {
    const patch = { ...result.patch };
    if (result.handoff) Object.assign(patch, { handled_by: 'human', attention: result.handoff, draft_text: result.draftText || null });
    patchDialog(dialog.id, patch);
    finishPlan(plan.id, { status: result.handoff ? 'handoff' : 'cancelled', reason: result.handoff || result.why });
    return result.handoff ? 'handoff' : 'silent';
  }

  // Режим «только черновики»: ответ готов, отправляет человек одной кнопкой.
  if (!cfg.autoReply) {
    finishPlan(plan.id, {
      status: 'draft',
      text: result.text,
      reply_key: result.replyKey,
      knowledge_id: result.knowledgeId ?? null,
      reason: result.handoff || result.why,
      patch: JSON.stringify({ patch: result.patch, handoff: result.handoff, lead: result.lead }),
    });
    patchDialog(dialog.id, { draft_text: result.text, attention: 'черновик ответа ждёт отправки' });
    return 'draft';
  }

  // Текст — в план ДО вызова Send API: по нему узнаётся ранний echo.
  finishPlan(plan.id, { text: result.text, reply_key: result.replyKey, knowledge_id: result.knowledgeId ?? null, reason: result.handoff || result.why });

  // Последняя сверка перед отправкой: человек мог вступить за эти секунды.
  dialog = getDialogRow(dialog.id);
  if (dialog.handled_by !== 'bot') {
    finishPlan(plan.id, { status: 'cancelled', reason: 'вступил человек' });
    return 'cancelled';
  }

  let sent;
  try {
    sent = await sendText({ projectId: dialog.project_id, channel: dialog.channel, peerId: dialog.peer_id, text: result.text });
  } catch (err) {
    const windowClosed = err instanceof SendError && err.windowClosed;
    finishPlan(plan.id, { status: windowClosed ? 'skipped' : 'failed', error: String(err.message).slice(0, 300) });
    patchDialog(dialog.id, { attention: windowClosed ? 'окно 24 часа закрыто — ответить может только человек' : 'ответ бота не отправился — ответьте вручную' });
    log('warn', `бот: ответ в диалог #${dialog.id} не ушёл — ${err.message}`);
    return windowClosed ? 'skipped' : 'failed';
  }

  recordBotSend(dialog, {
    mid: sent.mid,
    text: result.text,
    patch: result.patch,
    handoff: result.handoff,
    sentAt: iso(),
    meta: { key: result.replyKey, why: result.why },
  });
  finishPlan(plan.id, { status: 'sent' });
  if (result.knowledgeId) knowledge.bump(result.knowledgeId);
  if (result.lead) await maybeLead(dialog.id);
  return 'sent';
}

/**
 * Напоминания по тишине: мы задали вопрос и молчим. Первое — через 2 часа,
 * второе — через сутки, но не позже чем за час до конца окна 24 часов.
 */
export function scheduleReminders({ now = new Date() } = {}) {
  const t = ms(iso(now));
  const rows = db
    .prepare(
      `SELECT d.* FROM bot_dialogs d
        WHERE d.handled_by = 'bot' AND d.reminders_sent < 2 AND d.last_bot_at IS NOT NULL
          AND d.last_customer_at IS NOT NULL AND d.last_bot_at > d.last_customer_at
          AND NOT EXISTS (SELECT 1 FROM bot_reply_plans p WHERE p.dialog_id = d.id AND p.status IN ('pending', 'sending'))`
    )
    .all();
  let n = 0;
  for (const d of rows) {
    if (!WAITING_STEPS.includes(d.step)) continue;
    const cfg = knowledge.settings(d.project_id);
    if (!cfg.enabled || !cfg.channels.includes(d.channel)) continue;
    const windowEnd = ms(d.last_customer_at) + WINDOW_MS;
    const due = d.reminders_sent === 0
      ? ms(d.last_bot_at) + REMIND_FIRST_MS
      : Math.min(ms(d.last_bot_at) + REMIND_SECOND_MS, windowEnd - WINDOW_MARGIN_MS);
    // Проспали (воркер лежал) — в последние 10 минут окна уже не пишем.
    if (t < due || t >= windowEnd - 10 * 60 * 1000) continue;
    schedule(d.id, iso(now), 'remind');
    n += 1;
  }
  return n;
}

/**
 * Исходящие, застрявшие «в полёте» (воркер упал между выбором ответа и
 * записью mid). Ушло ли сообщение, видно по ленте: echo или наша запись
 * того же текста после создания плана — значит ушло, второй раз не шлём.
 * Иначе автоответ возвращается в очередь, черновик — в черновики, а ответ
 * человека помечается несостоявшимся: повторять его за человека нельзя.
 */
export function recoverStuck({ now = new Date() } = {}) {
  const stale = db
    .prepare("SELECT * FROM bot_reply_plans WHERE status = 'sending' AND updated_at < ?")
    .all(iso(ms(iso(now)) - SENDING_STALE_MS));
  for (const p of stale) {
    const delivered = p.text && db
      .prepare("SELECT 1 FROM bot_messages WHERE dialog_id = ? AND direction = 'out' AND text = ? AND created_at >= ?")
      .get(p.dialog_id, p.text, p.created_at);
    const status = delivered ? 'sent' : p.kind === 'human' ? 'failed' : p.patch ? 'draft' : 'pending';
    finishPlan(p.id, { status, reason: `восстановлен после сбоя: ${status}` });
    log('warn', `бот: план #${p.id} завис в отправке — ${delivered ? 'сообщение уже ушло' : `возвращён в «${status}»`}`);
  }
  return stale.length;
}

/** Один заход воркера. */
export async function runDue({ now = new Date() } = {}) {
  recoverStuck({ now });
  scheduleReminders({ now });
  const due = db
    .prepare("SELECT id FROM bot_reply_plans WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT 20")
    .all(iso(now));
  const out = [];
  for (const p of due) out.push(await processPlan(p.id, { now }));
  return out;
}

/* ---------------------------------- панель ---------------------------------- */

function dialogView(d) {
  const windowLeftMs = d.last_customer_at ? Math.max(0, ms(d.last_customer_at) + WINDOW_MS - Date.now()) : 0;
  const last = db.prepare('SELECT text, source, sent_at FROM bot_messages WHERE dialog_id = ? ORDER BY id DESC LIMIT 1').get(d.id);
  return {
    id: d.id,
    channel: d.channel,
    // Собеседника показываем хвостом id: имени Meta без отдельного запроса не даёт.
    who: d.contact_name || `Клиент …${String(d.peer_id).slice(-4)}`,
    handledBy: d.handled_by,
    humanAt: d.human_at,
    lastCustomerAt: d.last_customer_at,
    lastMessageAt: d.last_message_at,
    windowLeftMs,
    lang: d.lang,
    step: d.step,
    childAge: d.child_age,
    phone: d.phone,
    preferredTime: d.preferred_time,
    tags: String(d.tags || '').split(',').filter(Boolean),
    unread: d.unread,
    attention: d.attention,
    draftText: d.draft_text,
    lead: d.lead_status ? { status: d.lead_status, id: d.lead_id, error: d.lead_error } : null,
    last: last ? { text: String(last.text).slice(0, 140), source: last.source, at: last.sent_at } : null,
  };
}

export function listDialogs(projectId) {
  return db
    .prepare('SELECT * FROM bot_dialogs WHERE project_id = ? ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 300')
    .all(projectId)
    .map(dialogView);
}

export function getDialog(id, projectId) {
  const d = getDialogRow(id);
  if (!d || d.project_id !== projectId) return null;
  return d;
}

export function openDialog(id, projectId) {
  const d = getDialog(id, projectId);
  if (!d) return null;
  patchDialog(d.id, { unread: 0 });
  const messages = db
    .prepare('SELECT id, direction, text, source, staff_id, meta, sent_at FROM bot_messages WHERE dialog_id = ? ORDER BY sent_at, id')
    .all(d.id)
    .map((m) => ({ id: m.id, direction: m.direction, text: m.text, source: m.source, staffId: m.staff_id, meta: m.meta ? JSON.parse(m.meta) : null, at: m.sent_at }));
  return { dialog: dialogView({ ...d, unread: 0 }), messages };
}

export class DialogError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

function assertWindow(d) {
  if (!d.last_customer_at || Date.now() - ms(d.last_customer_at) >= WINDOW_MS) {
    throw new DialogError('Окно 24 часа закрыто: Meta не пропустит сообщение. Ответьте из приложения Instagram (с меткой Human Agent — до 7 дней)');
  }
}

/** Ответ человека из панели: диалог дальше за ним. */
export async function humanReply(id, projectId, staffId, text) {
  const d = getDialog(id, projectId);
  if (!d) throw new DialogError('Диалог не найден', 404);
  const body = String(text || '').trim();
  if (!body) throw new DialogError('Пустое сообщение');
  if (body.length > 1000) throw new DialogError('Direct режет сообщения длиннее 1000 символов');
  assertWindow(d);
  // Тот же текст только что ушёл — это второе нажатие или вторая вкладка.
  const dup = db
    .prepare("SELECT 1 FROM bot_messages WHERE dialog_id = ? AND source = 'human' AND text = ? AND created_at > ?")
    .get(d.id, body, iso(Date.now() - 60 * 1000));
  if (dup) throw new DialogError('Этот ответ уже отправлен минуту назад', 409);
  // Исходящее «в полёте» — строкой плана: по ней узнаётся ранний echo, а
  // уникальный индекс не пускает второй ответ, пока первый не ушёл.
  let planId;
  try {
    planId = Number(
      db.prepare("INSERT INTO bot_reply_plans (dialog_id, kind, send_at, status, text, reason) VALUES (?, 'human', ?, 'sending', ?, ?)")
        .run(d.id, iso(), body, `ответ из панели, сотрудник #${staffId ?? '—'}`).lastInsertRowid
    );
  } catch {
    throw new DialogError('Ответ в этот диалог уже отправляется — дождитесь его', 409);
  }
  // Забираем диалог у бота — чтобы план не ушёл, пока ждём Meta.
  patchDialog(d.id, { handled_by: 'human', human_at: iso(), human_by: staffId });
  cancelPending(d.id, 'ответил человек из панели');
  let sent;
  try {
    sent = await sendText({ projectId, channel: d.channel, peerId: d.peer_id, text: body });
  } catch (err) {
    finishPlan(planId, { status: 'failed', error: String(err.message).slice(0, 300) });
    throw new DialogError(`Meta не приняла сообщение: ${err.message}`, 502);
  }
  recordBotSend(d, { mid: sent.mid, text: body, patch: { unread: 0, attention: null }, sentAt: iso(), source: 'human', staffId });
  finishPlan(planId, { status: 'sent' });
  return openDialog(d.id, projectId);
}

/** Режим черновиков: отправить подготовленный ботом ответ одной кнопкой. */
export async function sendDraft(id, projectId, staffId) {
  const d = getDialog(id, projectId);
  if (!d) throw new DialogError('Диалог не найден', 404);
  const plan = db.prepare("SELECT * FROM bot_reply_plans WHERE dialog_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1").get(d.id);
  if (!plan || !d.draft_text) throw new DialogError('Черновика нет — возможно, его уже отправили', 409);
  assertWindow(d);
  let extra = { patch: {}, handoff: null, lead: false };
  try {
    extra = { ...extra, ...JSON.parse(plan.patch || '{}') };
  } catch {
    /* план без состояния — отправляем как есть */
  }
  // Захват черновика: из двух вкладок отправит одна, вторая получит 409.
  // Статус «sending» с текстом — по нему узнаётся ранний echo.
  let claimed;
  try {
    claimed = db
      .prepare("UPDATE bot_reply_plans SET status = 'sending', text = ?, updated_at = ? WHERE id = ? AND status = 'draft'")
      .run(d.draft_text, iso(), plan.id).changes;
  } catch {
    claimed = 0;
  }
  if (!claimed) throw new DialogError('Черновик уже отправляется или отправлен', 409);
  const sent = await sendText({ projectId, channel: d.channel, peerId: d.peer_id, text: d.draft_text }).catch((err) => {
    finishPlan(plan.id, { status: 'draft', error: String(err.message).slice(0, 300) });
    throw new DialogError(`Meta не приняла сообщение: ${err.message}`, 502);
  });
  recordBotSend(d, {
    mid: sent.mid,
    text: d.draft_text,
    patch: { ...extra.patch, attention: null },
    handoff: extra.handoff,
    sentAt: iso(),
    meta: { key: plan.reply_key, approvedBy: staffId },
  });
  finishPlan(plan.id, { status: 'sent' });
  if (plan.knowledge_id) knowledge.bump(plan.knowledge_id);
  if (extra.lead) await maybeLead(d.id);
  return openDialog(d.id, projectId);
}

/** «Вернуть боту»: следующий вопрос клиента бот разберёт сам. */
export function returnToBot(id, projectId) {
  const d = getDialog(id, projectId);
  if (!d) throw new DialogError('Диалог не найден', 404);
  /*
   * Бот должен помнить, что клиент уже сказал, — в том числе человеку: возраст
   * восстанавливается из сообщений клиента (последнее, где назван ровно один).
   * У ребёнка, пишущего самому, данных не берём вовсе.
   */
  const tags = String(d.tags || '').split(',');
  let age = d.child_age;
  if (!age && !tags.includes('child')) {
    const msgs = db.prepare("SELECT text FROM bot_messages WHERE dialog_id = ? AND source = 'customer' ORDER BY id DESC").all(d.id);
    for (const m of msgs) {
      const found = parseAges(m.text);
      if (found.length === 1) {
        age = found[0];
        break;
      }
    }
  }
  const STEP2 = new Set(['age_6_9', 'age_10_13', 'age_14_18']);
  const step2Sent = db
    .prepare("SELECT meta FROM bot_messages WHERE dialog_id = ? AND source = 'bot' AND meta IS NOT NULL")
    .all(d.id)
    .some((m) => {
      try {
        return STEP2.has(JSON.parse(m.meta).key);
      } catch {
        return false;
      }
    });
  let step = d.step;
  if ([STEP.done, STEP.birthday, STEP.start, STEP.askAge].includes(d.step)) step = step2Sent ? STEP.trial : age ? STEP.start : STEP.askAge;
  patchDialog(d.id, { handled_by: 'bot', attention: null, draft_text: null, step, child_age: age ?? null, reprompted: 0, reminders_sent: 2 });
  log('info', `бот: диалог #${d.id} возвращён боту`);
  return openDialog(d.id, projectId);
}

/** Повторить запись заявки в CRM (после того как владелец вписал ключ). */
export async function retryLead(id, projectId) {
  const d = getDialog(id, projectId);
  if (!d) throw new DialogError('Диалог не найден', 404);
  if (!d.phone) throw new DialogError('Телефона в диалоге нет — заявку не из чего делать');
  if (d.lead_status === 'sent') throw new DialogError('Заявка уже записана в CRM', 409);
  if (!(await maybeLead(d.id))) throw new DialogError('Заявка уже отправляется', 409);
  return openDialog(d.id, projectId);
}

/** Сводка для меню: сколько диалогов ждут человека. */
export function inboxCounts(projectId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN unread > 0 THEN 1 ELSE 0 END) AS unread,
              SUM(CASE WHEN attention IS NOT NULL THEN 1 ELSE 0 END) AS attention
         FROM bot_dialogs WHERE project_id = ?`
    )
    .get(projectId);
}
