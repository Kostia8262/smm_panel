/**
 * Письма рассылки: черновик, правка, аудитория, проверки, пробное письмо
 * версии, согласование (docs/рассылка.md, §9–10, фаза 3).
 *
 * Отпечаток содержимого (`content_hash`) держит три обещания:
 *   — утверждают ровно ту версию, которую видели в пробном письме;
 *   — правка после утверждения возвращает письмо в черновик;
 *   — отправка (фаза 4) не уйдёт, если отпечаток разошёлся с утверждённым.
 */

import { createHash } from 'node:crypto';
import { db, log } from '../db.js';
import { getProject } from '../projects.js';
import { requireApproval } from '../staff.js';
import { MailError, getList } from './store.js';
import { CONSENT_BASES } from './specs.js';
import { BLOCK_TYPES, renderLetter, sampleBlocks, safeUrl } from './compose/render.js';
import { brandFor, IMAGE_SLOTS } from './compose/brand.js';
import * as media from './compose/media.js';

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export const CAMPAIGN_STATUS = {
  draft: 'черновик',
  review: 'на согласовании',
  approved: 'утверждено',
  scheduled: 'запланировано',
  sending: 'отправляется',
  paused: 'на паузе',
  done: 'разослано',
  cancelled: 'отменено',
};

/** В каких состояниях письмо ещё можно править. Дальше — только пауза и отмена. */
const EDITABLE = ['draft', 'review', 'approved'];

export const LETTER_LIMITS = {
  blocks: 40,
  htmlBytes: 95 * 1024, // Gmail обрезает письмо после 102 КБ HTML — и первым пропадает подвал с отпиской
  totalBytes: 2 * 1024 * 1024,
  warnBytes: 300 * 1024,
  subjectWarn: 60,
};

const SHORTENERS = ['bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'cutt.ly', 'is.gd', 'ow.ly', 'rb.gy', 'shorturl.at'];

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const clip = (value, max) => String(value ?? '').replace(/\r\n/g, '\n').slice(0, max);

/* ------------------------------ блоки ------------------------------ */

/**
 * Блоки из редактора — к известному виду: неизвестные типы и поля отбрасываются,
 * длины режутся. В письмо попадает только то, что шаблон умеет рисовать.
 */
export function sanitizeBlocks(blocks) {
  if (!Array.isArray(blocks)) throw new MailError('Блоки письма не читаются');
  if (blocks.length > LETTER_LIMITS.blocks) throw new MailError(`В письме больше ${LETTER_LIMITS.blocks} блоков — это уже не письмо, а лонгрид`);
  return blocks
    .filter((b) => b && BLOCK_TYPES.includes(b.type))
    .map((b, index) => {
      const out = { id: clip(b.id || `b${index}${Date.now().toString(36)}`, 24), type: b.type };
      if (['eyebrow', 'heading', 'subheading'].includes(b.type)) out.text = clip(b.text, 200);
      if (b.type === 'text') out.text = clip(b.text, 5000);
      if (b.type === 'callout') {
        out.title = clip(b.title, 200);
        out.text = clip(b.text, 1500);
      }
      if (b.type === 'bullets') out.items = (Array.isArray(b.items) ? b.items : []).slice(0, 20).map((i) => clip(i, 300));
      if (b.type === 'button') {
        out.text = clip(b.text, 80);
        out.href = clip(b.href, 1000).trim();
        out.note = clip(b.note, 300);
      }
      if (['hero', 'image'].includes(b.type)) {
        out.mediaId = Number.isInteger(Number(b.mediaId)) && Number(b.mediaId) > 0 ? Number(b.mediaId) : null;
        out.alt = clip(b.alt, 200);
        out.href = clip(b.href, 1000).trim();
      }
      return out;
    });
}

/* ------------------------------ письмо ------------------------------ */

function rowOf(id) {
  const row = db.prepare('SELECT * FROM mail_campaigns WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) throw new MailError('Письмо не найдено', 404);
  return row;
}

function listsOf(campaignId) {
  const rows = db
    .prepare(
      `SELECT cl.list_id, cl.mode, l.name, l.consent_basis, l.archived_at FROM mail_campaign_lists cl
         JOIN mail_lists l ON l.id = cl.list_id WHERE cl.campaign_id = ? ORDER BY l.name`
    )
    .all(campaignId);
  return {
    include: rows.filter((r) => r.mode === 'include').map((r) => ({ id: r.list_id, name: r.name, consentBasis: r.consent_basis, archived: Boolean(r.archived_at) })),
    exclude: rows.filter((r) => r.mode === 'exclude').map((r) => ({ id: r.list_id, name: r.name, archived: Boolean(r.archived_at) })),
  };
}

/** Отпечаток: всё, что меняет письмо у получателя, и ничего служебного. */
export function contentHash(row, blocks = parseJson(row.blocks, [])) {
  const files = media.mediaMap(row.id);
  const payload = {
    subject: row.subject,
    preheader: row.preheader,
    fromName: row.from_name,
    replyTo: row.reply_to || '',
    senderId: row.sender_id || null,
    blocks: blocks.map(({ id, ...rest }) => ({ ...rest, file: rest.mediaId ? files.get(rest.mediaId)?.stored_name || null : undefined })),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function publicCampaign(row) {
  const blocks = parseJson(row.blocks, []);
  const files = media.mediaMap(row.id);
  const tested = row.content_hash
    ? Boolean(db.prepare('SELECT 1 FROM mail_test_sends WHERE campaign_id = ? AND content_hash = ? AND gmail_id IS NOT NULL').get(row.id, row.content_hash))
    : false;
  const sender = row.sender_id ? db.prepare('SELECT id, email, state, disconnected_at, display_name FROM mail_senders WHERE id = ?').get(row.sender_id) : null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    subject: row.subject,
    preheader: row.preheader,
    fromName: row.from_name,
    replyTo: row.reply_to || '',
    senderId: row.sender_id,
    sender: sender ? { id: sender.id, email: sender.email, state: sender.disconnected_at ? 'disconnected' : sender.state, displayName: sender.display_name } : null,
    blocks,
    media: Object.fromEntries(
      [...files.values()].map((m) => [m.id, { id: m.id, name: m.stored_name, width: m.width, height: m.height, bytes: m.bytes, originalName: m.original_name, purged: Boolean(m.purged_at) }])
    ),
    lists: listsOf(row.id),
    status: row.status,
    statusTitle: CAMPAIGN_STATUS[row.status] || row.status,
    editable: EDITABLE.includes(row.status),
    reviewNote: row.review_note,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by ? db.prepare('SELECT name FROM staff WHERE id = ?').get(row.approved_by)?.name || null : null,
    testedCurrent: tested,
    contentHash: row.content_hash,
    approvedCurrent: Boolean(row.approved_hash) && row.approved_hash === row.content_hash,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    pauseReason: row.pause_reason,
    progress: progressOf(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const SEND_STATUS = {
  queued: 'в очереди',
  sending: 'отправляется',
  sent: 'ушло',
  failed: 'не ушло',
  skipped: 'пропущено',
  unknown: 'судьба неизвестна',
  cancelled: 'отменено',
};

/** Письма рассылки поимённо: сначала беды, потом ушедшие. */
export function listSends(campaignId, { status = '', page = 1, pageSize = 50 } = {}) {
  const where = ['campaign_id = ?'];
  const params = [Number(campaignId)];
  if (status && SEND_STATUS[status]) {
    where.push('status = ?');
    params.push(status);
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM mail_sends WHERE ${where.join(' AND ')}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT id, email, name, status, attempts, sent_at, error FROM mail_sends WHERE ${where.join(' AND ')}
       ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'unknown' THEN 1 WHEN 'sending' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END, id
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return {
    total,
    page,
    pageSize,
    statuses: SEND_STATUS,
    sends: rows.map((r) => ({ id: r.id, email: r.email, name: r.name, status: r.status, statusTitle: SEND_STATUS[r.status], attempts: r.attempts, sentAt: r.sent_at, error: r.error })),
  };
}

/** Строка письма как в базе — отправщику нужен утверждённый отпечаток и карта ссылок. */
export function campaignRow(id) {
  return rowOf(id);
}

/**
 * Сколько писем рассылки в каком состоянии. До старта снимка нет — и счётчиков нет.
 * @returns {{total: number, queued: number, sending: number, sent: number, failed: number, skipped: number, unknown: number, cancelled: number}|null}
 */
export function progressOf(campaignId) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM mail_sends WHERE campaign_id = ? GROUP BY status').all(Number(campaignId));
  if (!rows.length) return null;
  const out = { total: 0, queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0, unknown: 0, cancelled: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}

export function getCampaign(id, projectId = null) {
  const row = rowOf(id);
  if (projectId && row.project_id !== Number(projectId)) throw new MailError('Письмо не найдено', 404);
  return publicCampaign(row);
}

export function listCampaigns(projectId) {
  return db
    .prepare('SELECT * FROM mail_campaigns WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC')
    .all(Number(projectId))
    .map((row) => {
      const c = publicCampaign(row);
      return {
        id: c.id,
        title: c.title,
        subject: c.subject,
        status: c.status,
        statusTitle: c.statusTitle,
        lists: c.lists.include.map((l) => l.name),
        sender: c.sender?.email || null,
        updatedAt: c.updatedAt,
        testedCurrent: c.testedCurrent,
        scheduledAt: c.scheduledAt,
        finishedAt: c.finishedAt,
        pauseReason: c.pauseReason,
        progress: c.progress,
        audience: c.progress ? c.progress.total : audience(c).recipients,
      };
    });
}

function defaultSenderId() {
  return db.prepare("SELECT id FROM mail_senders WHERE disconnected_at IS NULL AND state != 'dead' ORDER BY id LIMIT 1").get()?.id || null;
}

/** Новое письмо — с образца: пустая страница пугает сильнее, чем чужой текст, который надо заменить. */
export function createCampaign(projectId, { staffId = null } = {}) {
  const project = getProject(projectId);
  if (!project) throw new MailError('Проект не найден', 404);
  const brand = brandFor(project);
  const blocks = sanitizeBlocks(sampleBlocks(project, brand).map((b, i) => ({ ...b, id: `s${i}` })));
  const info = db
    .prepare('INSERT INTO mail_campaigns (project_id, sender_id, title, blocks, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(project.id, defaultSenderId(), 'Новое письмо', JSON.stringify(blocks), staffId);
  const id = Number(info.lastInsertRowid);
  refreshHash(id);
  log('info', `рассылка: создано письмо #${id}`);
  return getCampaign(id);
}

export function copyCampaign(id, { staffId = null } = {}) {
  const row = rowOf(id);
  const info = db
    .prepare(
      `INSERT INTO mail_campaigns (project_id, sender_id, title, subject, preheader, from_name, reply_to, blocks, copied_from, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.project_id, row.sender_id, `${row.title} (копия)`.slice(0, 120), row.subject, row.preheader, row.from_name, row.reply_to, row.blocks, row.id, staffId);
  const copyId = Number(info.lastInsertRowid);
  const remap = media.copyMedia(row.id, copyId);
  const blocks = parseJson(row.blocks, []).map((b) => (b.mediaId ? { ...b, mediaId: remap.get(b.mediaId) || null } : b));
  db.prepare('UPDATE mail_campaigns SET blocks = ? WHERE id = ?').run(JSON.stringify(blocks), copyId);
  db.prepare('INSERT INTO mail_campaign_lists (campaign_id, list_id, mode) SELECT ?, list_id, mode FROM mail_campaign_lists WHERE campaign_id = ?').run(copyId, row.id);
  refreshHash(copyId);
  log('info', `рассылка: письмо #${row.id} скопировано в #${copyId}`);
  return getCampaign(copyId);
}

function refreshHash(id) {
  const row = rowOf(id);
  const hash = contentHash(row);
  db.prepare('UPDATE mail_campaigns SET content_hash = ? WHERE id = ?').run(hash, row.id);
  return hash;
}

/**
 * @param {{title?, subject?, preheader?, fromName?, replyTo?, senderId?, blocks?, lists?: {include: number[], exclude: number[]}}} patch
 */
export function updateCampaign(id, patch) {
  const row = rowOf(id);
  if (!EDITABLE.includes(row.status)) throw new MailError('Письмо уже отправляется или разослано — его можно только поставить на паузу или отменить', 409);

  const sets = [];
  const params = [];
  const text = (key, column, max) => {
    if (patch[key] === undefined) return;
    sets.push(`${column} = ?`);
    params.push(clip(patch[key], max).replace(/\n/g, ' ').trim());
  };
  text('title', 'title', 120);
  text('subject', 'subject', 150);
  text('preheader', 'preheader', 200);
  text('fromName', 'from_name', 80);
  if (patch.replyTo !== undefined) {
    const value = String(patch.replyTo || '').trim().toLowerCase();
    if (value && !/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(value)) throw new MailError('Адрес для ответов не похож на адрес почты');
    sets.push('reply_to = ?');
    params.push(value || null);
  }
  if (patch.senderId !== undefined) {
    const sender = patch.senderId ? db.prepare('SELECT id FROM mail_senders WHERE id = ? AND disconnected_at IS NULL').get(Number(patch.senderId)) : null;
    if (patch.senderId && !sender) throw new MailError('Такого подключённого ящика нет');
    sets.push('sender_id = ?');
    params.push(sender ? sender.id : null);
  }
  let blocks;
  if (patch.blocks !== undefined) {
    blocks = sanitizeBlocks(patch.blocks);
    const files = media.mediaMap(row.id);
    for (const b of blocks) if (b.mediaId && !files.has(b.mediaId)) b.mediaId = null;
    sets.push('blocks = ?');
    params.push(JSON.stringify(blocks));
  }

  db.exec('BEGIN');
  try {
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(nowIso());
      db.prepare(`UPDATE mail_campaigns SET ${sets.join(', ')} WHERE id = ?`).run(...params, row.id);
    }
    if (patch.lists !== undefined) setLists(row, patch.lists);
    const hash = refreshHash(row.id);
    // Утверждали другую версию — эта снова черновик. Базы в отпечаток не
    // входят: их меняют и после утверждения, до отправки.
    if (['review', 'approved'].includes(row.status) && hash !== row.content_hash) {
      db.prepare("UPDATE mail_campaigns SET status = 'draft', approved_by = NULL, approved_at = NULL, approved_hash = NULL WHERE id = ?").run(row.id);
      log('warn', `рассылка: письмо #${row.id} изменено после ${row.status === 'approved' ? 'утверждения' : 'отправки на согласование'} — вернулось в черновик`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getCampaign(row.id);
}

function setLists(row, { include = [], exclude = [] }) {
  const clean = (ids) => [...new Set((ids || []).map(Number).filter(Boolean))];
  const inc = clean(include);
  const exc = clean(exclude).filter((id) => !inc.includes(id));
  for (const id of [...inc, ...exc]) {
    const list = getList(id);
    if (!list || list.projectId !== row.project_id) throw new MailError('База не найдена или из другой школы', 404);
  }
  db.prepare('DELETE FROM mail_campaign_lists WHERE campaign_id = ?').run(row.id);
  const insert = db.prepare('INSERT INTO mail_campaign_lists (campaign_id, list_id, mode) VALUES (?, ?, ?)');
  for (const id of inc) insert.run(row.id, id, 'include');
  for (const id of exc) insert.run(row.id, id, 'exclude');
  db.prepare('UPDATE mail_campaigns SET updated_at = ? WHERE id = ?').run(nowIso(), row.id);
}

export function removeCampaign(id) {
  const row = rowOf(id);
  if (['sending', 'scheduled', 'paused'].includes(row.status)) throw new MailError('Письмо в отправке — сначала отмените её', 409);
  db.prepare('UPDATE mail_campaigns SET deleted_at = ? WHERE id = ?').run(nowIso(), row.id);
  log('info', `рассылка: письмо #${row.id} «${row.title}» убрано`);
}

/* ------------------------------ аудитория ------------------------------ */

/**
 * Сколько людей получат письмо. Человек в двух базах — одно письмо;
 * отписавшиеся и недоставляемые не считаются.
 */
export function audience(campaign) {
  const inc = campaign.lists.include.map((l) => l.id);
  const exc = campaign.lists.exclude.map((l) => l.id);
  if (!inc.length) return { inLists: 0, recipients: 0, unsubscribed: 0, undeliverable: 0, excluded: 0 };
  const incSql = inc.map(() => '?').join(',');
  const excSql = exc.length ? `AND NOT EXISTS (SELECT 1 FROM mail_list_members x WHERE x.contact_id = c.id AND x.removed_at IS NULL AND x.list_id IN (${exc.map(() => '?').join(',')}))` : '';
  const base = `FROM mail_contacts c WHERE c.project_id = ? AND EXISTS (SELECT 1 FROM mail_list_members m WHERE m.contact_id = c.id AND m.removed_at IS NULL AND m.list_id IN (${incSql}))`;
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(c.status = 'active') AS active,
              SUM(c.status = 'unsubscribed') AS unsubscribed,
              SUM(c.status IN ('bounced', 'invalid')) AS undeliverable
       ${base}`
    )
    .get(campaign.projectId, ...inc);
  const recipients = exc.length
    ? db.prepare(`SELECT COUNT(*) AS n ${base} AND c.status = 'active' ${excSql}`).get(campaign.projectId, ...inc, ...exc).n
    : counts.active || 0;
  return {
    inLists: counts.total || 0,
    recipients,
    unsubscribed: counts.unsubscribed || 0,
    undeliverable: counts.undeliverable || 0,
    excluded: (counts.active || 0) - recipients,
  };
}

/* ------------------------------ сборка ------------------------------ */

function reasonOf(campaign) {
  const basis = campaign.lists.include[0]?.consentBasis;
  return (CONSENT_BASES[basis] || CONSENT_BASES.other).footer;
}

/**
 * Собрать письмо. `preview` — картинки data:-адресами для страницы
 * предпросмотра; `send` — вложениями Content-ID для настоящего письма.
 *
 * @returns {{html: string, text: string, inline: object[], subject: string, fromName: string, missingImages: string[]}}
 */
export function buildLetter(campaign, { mode = 'preview', vars = {}, unsubscribeUrl = '', reason = null } = {}) {
  const project = getProject(campaign.projectId);
  const brand = brandFor(project);
  const files = media.mediaMap(campaign.id);
  const inline = [];
  const missingImages = [];

  const blocks = campaign.blocks.map((b) => {
    if (!['hero', 'image'].includes(b.type)) return b;
    const row = b.mediaId ? files.get(b.mediaId) : null;
    const content = row ? media.readMedia(row) : null;
    if (!content) {
      missingImages.push(b.type === 'hero' ? IMAGE_SLOTS.hero.title : IMAGE_SLOTS.inline.title);
      return { ...b, src: '' };
    }
    if (mode === 'send') {
      const cid = `m${row.id}.${campaign.id}@mail.panel`;
      if (!inline.some((i) => i.cid === cid)) inline.push({ cid, mime: row.mime, content, filename: row.stored_name });
      return { ...b, src: `cid:${cid}` };
    }
    return { ...b, src: `data:${row.mime};base64,${content.toString('base64')}` };
  });

  const fromName = campaign.fromName || campaign.sender?.displayName || project.title;
  const { html, text } = renderLetter({
    brand,
    subject: campaign.subject,
    preheader: campaign.preheader,
    blocks,
    vars,
    signature: project.signature,
    reason: reason ?? reasonOf(campaign),
    unsubscribeUrl,
  });
  return { html, text, inline, subject: campaign.subject, fromName, missingImages };
}

/* ------------------------------ проверки ------------------------------ */

/**
 * Блокеры не пускают дальше (площадка — здесь Gmail или получатель —
 * пострадает); предупреждения — решение человека. Тот же принцип, что у
 * проверки постов.
 */
export function checkCampaign(campaign) {
  const blockers = [];
  const warnings = [];
  const aud = audience(campaign);

  if (!campaign.subject.trim()) blockers.push('Нет темы письма');
  if (!campaign.blocks.length) blockers.push('Письмо пустое — добавьте хотя бы заголовок и текст');
  if (!campaign.sender) blockers.push('Не выбран ящик, с которого уйдёт письмо');
  else if (campaign.sender.state === 'dead' || campaign.sender.state === 'disconnected') blockers.push(`Ящик ${campaign.sender.email} потерял доступ к Gmail — подключите его заново`);
  if (!campaign.lists.include.length) blockers.push('Не выбраны базы получателей');
  else if (!aud.recipients) blockers.push('В выбранных базах нет активных адресов');
  if (campaign.lists.include.some((l) => l.archived)) warnings.push('Среди баз есть убранная в архив');

  for (const b of campaign.blocks) {
    if (b.type === 'button' && !safeUrl(b.href)) blockers.push(`Кнопка «${b.text || 'без надписи'}» без ссылки (нужна https://…)`);
    if (['hero', 'image'].includes(b.type)) {
      const file = b.mediaId ? campaign.media[b.mediaId] : null;
      const title = b.type === 'hero' ? 'Главная картинка' : 'Картинка в тексте';
      if (!file || file.purged) blockers.push(`Блок «${title}» без картинки — загрузите её или уберите блок`);
      else {
        if (!b.alt?.trim()) warnings.push(`У блока «${title}» нет описания (alt): его покажут, если картинки в почте отключены`);
        const want = b.type === 'hero' ? 2 : 16 / 9;
        const ratio = file.width / file.height;
        if (Math.abs(ratio - want) / want > 0.08) {
          const slot = b.type === 'hero' ? IMAGE_SLOTS.hero : IMAGE_SLOTS.inline;
          warnings.push(`«${title}» ${file.width}×${file.height}: пропорции не как у ${slot.width}×${slot.height} — встанет, но выйдет ${ratio < want ? 'выше' : 'ниже'} шаблона`);
        }
        if (b.href && !safeUrl(b.href)) warnings.push(`У блока «${title}» ссылка не https — картинка не будет кликабельной`);
      }
    }
    for (const field of [b.text, b.title, b.note, ...(b.items || [])]) {
      for (const m of String(field || '').matchAll(/\{\{\s*(\w+)/g)) {
        if (m[1] !== 'name') blockers.push(`Неизвестная подстановка {{${m[1]}}} — доступна только {{name|…}}`);
      }
      for (const m of String(field || '').matchAll(/https?:\/\/([^/\s)]+)/g)) {
        if (SHORTENERS.includes(m[1].toLowerCase())) warnings.push(`Ссылка через сокращатель ${m[1]}: почтовые фильтры его не любят — дайте прямую ссылку`);
      }
    }
  }

  if (campaign.subject.length > LETTER_LIMITS.subjectWarn) warnings.push(`Тема длиннее ${LETTER_LIMITS.subjectWarn} знаков — на телефоне обрежется`);
  const letters = campaign.subject.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 8 && letters === letters.toUpperCase()) warnings.push('Тема капсом — почтовые фильтры считают это признаком спама');
  if (/!{2,}/.test(campaign.subject)) warnings.push('«!!» в теме — признак спама для фильтров');
  if (!campaign.preheader.trim()) warnings.push('Нет прехедера — во «Входящих» рядом с темой покажется начало письма');
  if (!campaign.blocks.some((b) => ['text', 'heading', 'bullets', 'callout'].includes(b.type))) warnings.push('В письме нет текста — письмо из одних картинок фильтры считают спамом');

  const built = buildLetter(campaign, { mode: 'send', unsubscribeUrl: 'https://example.invalid/u/placeholder' });
  const htmlBytes = Buffer.byteLength(built.html);
  const imageBytes = built.inline.reduce((sum, i) => sum + i.content.length, 0);
  const totalBytes = Math.round(htmlBytes + Buffer.byteLength(built.text) + imageBytes * 1.37);
  if (htmlBytes > LETTER_LIMITS.htmlBytes) blockers.push(`Текст письма ${Math.round(htmlBytes / 1024)} КБ — Gmail обрежет его после 102 КБ и спрячет ссылку отписки. Сократите текст`);
  if (totalBytes > LETTER_LIMITS.totalBytes) blockers.push(`Письмо весит ${(totalBytes / 1048576).toFixed(1)} МБ — уменьшите картинки`);
  else if (totalBytes > LETTER_LIMITS.warnBytes) warnings.push(`Письмо весит ${Math.round(totalBytes / 1024)} КБ: медленно откроется, и каждая копия ляжет в «Отправленные»`);

  return {
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    audience: aud,
    stats: { htmlBytes, totalBytes, images: built.inline.length },
  };
}

/* --------------------------- пробное письмо --------------------------- */

export async function sendCampaignTest(id, { to = [], staffId = null, publicBase, fetchImpl, projectId = null }) {
  const campaign = getCampaign(id, projectId);
  if (!campaign.sender) throw new MailError('Выберите ящик, с которого уйдёт письмо');
  if (!campaign.subject.trim()) throw new MailError('Сначала напишите тему письма');
  const { tokenFor, unsubscribeUrl } = await import('./unsubscribe.js');
  const { sendTestMessage } = await import('./sender/senders.js');
  const unsubscribe = unsubscribeUrl(publicBase, tokenFor({ projectId: campaign.projectId, contactId: 0, campaignId: 0 }));
  const built = buildLetter(campaign, { mode: 'send', unsubscribeUrl: unsubscribe });
  if (built.missingImages.length) throw new MailError(`Загрузите картинки или уберите пустые блоки: ${[...new Set(built.missingImages)].join(', ')}`);
  return sendTestMessage(campaign.sender.id, {
    to,
    fromName: built.fromName,
    subject: `[Пробний] ${built.subject}`,
    html: built.html,
    text: built.text,
    inline: built.inline,
    replyTo: campaign.replyTo,
    unsubscribe,
    campaignId: campaign.id,
    contentHash: campaign.contentHash,
    staffId,
    fetchImpl,
  });
}

/* ------------------------------ согласование ------------------------------ */

function readyOrThrow(campaign) {
  const check = checkCampaign(campaign);
  if (check.blockers.length) throw new MailError(`Письмо не готово: ${check.blockers[0]}`, 422);
  if (!campaign.testedCurrent) throw new MailError('Сначала отправьте себе пробное письмо этой версии и посмотрите его в почте', 422);
  return check;
}

/**
 * Отправить на согласование. Владелец согласовывает себя сразу, а если
 * согласование выключено — любой.
 */
export function submitCampaign(id, user, projectId = null) {
  const campaign = getCampaign(id, projectId);
  if (!['draft', 'review'].includes(campaign.status)) throw new MailError('Письмо уже не черновик', 409);
  readyOrThrow(campaign);
  if (user.role === 'owner' || !requireApproval()) return approveCampaign(id, user, projectId);
  db.prepare("UPDATE mail_campaigns SET status = 'review', review_note = NULL, updated_at = ? WHERE id = ?").run(nowIso(), campaign.id);
  log('info', `рассылка: письмо #${campaign.id} отправлено на согласование: ${user.name}`);
  return getCampaign(campaign.id);
}

export function approveCampaign(id, user, projectId = null) {
  const campaign = getCampaign(id, projectId);
  if (!['draft', 'review'].includes(campaign.status)) throw new MailError('Утвердить можно черновик или письмо на согласовании', 409);
  readyOrThrow(campaign);
  db.prepare(
    "UPDATE mail_campaigns SET status = 'approved', approved_by = ?, approved_at = ?, approved_hash = content_hash, review_note = NULL, updated_at = ? WHERE id = ?"
  ).run(user.id, nowIso(), nowIso(), campaign.id);
  log('info', `рассылка: письмо #${campaign.id} утверждено: ${user.name}`);
  return getCampaign(campaign.id);
}

export function rejectCampaign(id, user, note, projectId = null) {
  const campaign = getCampaign(id, projectId);
  const reason = String(note || '').trim();
  if (!reason) throw new MailError('Напишите, что поправить');
  if (!['review', 'approved'].includes(campaign.status)) throw new MailError('Вернуть можно письмо на согласовании или утверждённое', 409);
  db.prepare("UPDATE mail_campaigns SET status = 'draft', review_note = ?, approved_by = NULL, approved_at = NULL, approved_hash = NULL, updated_at = ? WHERE id = ?").run(
    reason.slice(0, 500),
    nowIso(),
    campaign.id
  );
  log('warn', `рассылка: письмо #${campaign.id} возвращено на доработку: ${user.name}`);
  return getCampaign(campaign.id);
}
