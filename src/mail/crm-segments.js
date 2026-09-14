/**
 * Сегменты CRM школы → базы рассылки (фаза 6 моста «CRM ↔ панель», 14.09.2026).
 *
 * Владелец включает сегмент в админке («Батьки активних учнів», «Учні на
 * паузі»…), панель раз в 15 минут забирает его состав и держит по базе на
 * сегмент и школу:
 *
 *   — база сегмента принадлежит синхронизации (`mail_lists.crm_segment`):
 *     имя = title из админки, состав, архив ведёт воркер; руками их не правят
 *     (store.assertEditable), иначе следующий заход молча откатил бы правку;
 *   — новый адрес в сегменте → в базу; выпал из сегмента → `removed_at`, но
 *     НЕ в стоп-лист: выпал из «активных учеников» не значит «не пишите»;
 *   — отказ сильнее сегмента: отписавшийся, стёртый, недоставляемый адрес
 *     активным не возвращается — как у ленты согласий;
 *   — сегмента больше нет в списке (владелец выключил) или состав ответил 404 →
 *     база в архив без удаления; включили снова — та же база возвращается;
 *   — основание согласия: client | lead по каждому адресу (колонка
 *     «Основание»), у базы — слабейшее из встреченных: хоть одна заявка →
 *     «Заявка с согласием».
 *
 * Контракт (вкладка админки my-computer-new-6a, 14.09.2026, админка 38486b2e):
 *   GET /api/integration/mail/segments?project=<slug>
 *     → { segments: [{ key, title, description, count, computedAt }] }
 *   GET /api/integration/mail/segments/:key/members?project=<slug>
 *     → { key, title, computedAt, count, members: [{ email, basis }] }
 *   Ключ — тот же `mail:feed`, что у ленты (`crm_feed_token`). Лимит админки
 *   900 запросов за 15 минут с адреса; заход — до 7 запросов на школу.
 */

import { db, log } from '../db.js';
import { getSetting, setSetting } from '../staff.js';
import { getProjectBySlug } from '../projects.js';
import * as store from './store.js';
import { checkAddress } from './import/address.js';
import { feedAccess, integrationFetch } from './crm-feed.js';

/** Школы, у которых в админке есть сегменты. Порядок — порядок опроса. */
export const SEGMENT_SCHOOLS = ['education', 'school', 'child', 'fluentfox'];
export const SEGMENTS_INTERVAL_MS = 15 * 60 * 1000;

const SEGMENT_KEY = /^[a-z0-9_]{1,40}$/;
const BASIS_TITLE = { client: 'клиент', lead: 'заявка' };
const COLUMNS = ['Основание'];

const nowIso = (now = Date.now()) => new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function segmentsState() {
  let lastStats = null;
  try {
    lastStats = JSON.parse(getSetting('crm_segments_last_stats', '') || 'null');
  } catch {
    lastStats = null;
  }
  return {
    lastAt: getSetting('crm_segments_last_at', '') || null,
    lastError: getSetting('crm_segments_last_error', '') || null,
    lastStats,
  };
}

/** Имя базы: title из админки; занято обычной базой школы — с пометкой, чтобы не столкнуться. */
function listName(projectId, title, key, ownId) {
  const base = String(title || '').trim().slice(0, 110) || `CRM: ${key}`;
  const taken = db.prepare('SELECT 1 FROM mail_lists WHERE project_id = ? AND name = ? AND id IS NOT ?');
  if (!taken.get(projectId, base, ownId)) return base;
  const marked = `${base} · ${key}`;
  return taken.get(projectId, marked, ownId) ? `${base} · ${key} · ${ownId ?? Date.now()}` : marked;
}

/** База сегмента: найти по ключу или завести; архивную вернуть — это та же база. */
function segmentList(project, segment, basis, now) {
  const row = db.prepare('SELECT * FROM mail_lists WHERE project_id = ? AND crm_segment = ?').get(project.id, segment.key);
  const name = listName(project.id, segment.title, segment.key, row?.id ?? null);
  const description = String(segment.description || '').trim().slice(0, 500) || 'Сегмент CRM школы: состав ведёт админка';
  if (!row) {
    const info = db
      .prepare(
        `INSERT INTO mail_lists (project_id, name, description, consent_basis, consent_note, columns, crm_segment, crm_synced_at)
         VALUES (?, ?, ?, ?, '', ?, ?, ?)`
      )
      .run(project.id, name, description, basis || 'lead', JSON.stringify(COLUMNS), segment.key, nowIso(now));
    log('info', `рассылка: заведена база сегмента CRM «${name}» (${project.slug})`);
    return { id: Number(info.lastInsertRowid), created: true, restored: false };
  }
  db.prepare(
    `UPDATE mail_lists SET name = ?, description = ?, consent_basis = ?, archived_at = NULL, crm_synced_at = ? WHERE id = ?`
  ).run(name, description, basis || row.consent_basis, nowIso(now), row.id);
  store.mergeListColumns(row.id, COLUMNS);
  if (row.archived_at) log('info', `рассылка: сегмент CRM «${name}» снова включён — база возвращена из архива`);
  return { id: row.id, created: false, restored: Boolean(row.archived_at) };
}

/**
 * Состав одного сегмента → база. Одна транзакция: база не бывает полусобранной.
 * @returns {{added: number, removed: number, kept: number, refused: number, invalid: number}}
 */
export function applySegment(project, segment, members, now = Date.now()) {
  const stats = { added: 0, removed: 0, kept: 0, refused: 0, invalid: 0 };
  const wanted = new Map();
  for (const m of Array.isArray(members) ? members : []) {
    const check = checkAddress(String(m?.email || '').trim().toLowerCase());
    if ((check.verdict !== 'ok' && check.verdict !== 'warning') || !BASIS_TITLE[m?.basis]) {
      stats.invalid++;
      continue;
    }
    // Один адрес — один человек; пришёл дважды — сильнее основание клиента.
    if (wanted.get(check.email) !== 'client') wanted.set(check.email, m.basis);
  }
  const bases = [...wanted.values()];
  const basis = bases.includes('lead') ? 'lead' : bases.length ? 'client' : null;

  db.exec('BEGIN');
  try {
    const list = segmentList(project, segment, basis, now);
    const contactOf = db.prepare('SELECT id, status FROM mail_contacts WHERE project_id = ? AND email = ?');

    for (const [email, memberBasis] of wanted) {
      const contact = contactOf.get(project.id, email);
      if (store.isSuppressed(project.id, email) || (contact && contact.status !== 'active')) {
        stats.refused++;
        continue;
      }
      // Имя в CRM — имя ребёнка; админка его и не отдаёт. {{name}} уйдёт в запасное слово.
      const contactId = store.upsertContact(project.id, email, '').id;
      if (store.addMembership(list.id, contactId, { attrs: { Основание: BASIS_TITLE[memberBasis] } }) === 'added') {
        stats.added++;
        db.prepare("INSERT INTO mail_events (project_id, contact_id, type, source, note) VALUES (?, ?, 'subscribed', 'crm_segment', ?)").run(
          project.id,
          contactId,
          `${segment.key} · ${memberBasis} · ${segment.computedAt || ''}`
        );
      } else {
        stats.kept++;
      }
    }

    // Выбывшие: из базы, но не в стоп-лист.
    const present = db
      .prepare(
        `SELECT c.id, c.email FROM mail_list_members m JOIN mail_contacts c ON c.id = m.contact_id
          WHERE m.list_id = ? AND m.removed_at IS NULL`
      )
      .all(list.id);
    const drop = db.prepare('UPDATE mail_list_members SET removed_at = ? WHERE list_id = ? AND contact_id = ? AND removed_at IS NULL');
    for (const row of present) {
      if (!wanted.has(row.email)) stats.removed += drop.run(nowIso(now), list.id, row.id).changes;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return stats;
}

/** Базы сегментов школы, которых больше нет среди включённых, — в архив, без удаления. */
function archiveMissing(project, liveKeys, now) {
  const stale = db
    .prepare('SELECT id, name, crm_segment FROM mail_lists WHERE project_id = ? AND crm_segment IS NOT NULL AND archived_at IS NULL')
    .all(project.id)
    .filter((l) => !liveKeys.has(l.crm_segment));
  for (const l of stale) {
    db.prepare('UPDATE mail_lists SET archived_at = ?, crm_synced_at = ? WHERE id = ?').run(nowIso(now), nowIso(now), l.id);
    log('info', `рассылка: сегмент CRM «${l.name}» выключен в админке — база убрана в архив`);
  }
  return stale.length;
}

/** Одна школа: список включённых → состав каждого → базы. */
async function syncSchool(project, { access, fetchImpl, now }) {
  const q = `?project=${encodeURIComponent(project.slug)}`;
  const data = await integrationFetch(`/api/integration/mail/segments${q}`, { ...access, fetchImpl });
  if (!Array.isArray(data?.segments)) throw new Error('Список сегментов пришёл без segments');
  const total = { segments: 0, added: 0, removed: 0, kept: 0, refused: 0, invalid: 0, archived: 0 };
  const live = new Set();
  for (const segment of data.segments) {
    if (!SEGMENT_KEY.test(String(segment?.key || ''))) continue;
    const out = await integrationFetch(`/api/integration/mail/segments/${encodeURIComponent(segment.key)}/members${q}`, {
      ...access,
      fetchImpl,
      missing: null,
    });
    // 404 между двумя запросами — сегмент только что выключили: пусть уйдёт в архив.
    if (out === null) continue;
    if (!Array.isArray(out?.members)) throw new Error(`Состав сегмента ${segment.key} пришёл без members`);
    live.add(segment.key);
    const stats = applySegment(project, { ...segment, title: out.title || segment.title, computedAt: out.computedAt || segment.computedAt }, out.members, now);
    total.segments++;
    for (const [k, v] of Object.entries(stats)) total[k] += v;
  }
  total.archived = archiveMissing(project, live, now);
  return total;
}

/** Нужен ли заход: раз в 15 минут, считая от последнего удачного или неудачного. */
export function segmentsDue(now = Date.now()) {
  const tried = Number(getSetting('crm_segments_tried', '0'));
  return now - tried >= SEGMENTS_INTERVAL_MS;
}

/**
 * Один заход воркера по всем школам.
 * @returns {Promise<{schools: object}|null>} null — ключ ленты не вписан
 */
export async function pullSegments({ access = feedAccess(), fetchImpl, now = Date.now() } = {}) {
  if (!access.apiKey) return null;
  setSetting('crm_segments_tried', String(now));
  const schools = {};
  const errors = [];
  for (const slug of SEGMENT_SCHOOLS) {
    const project = getProjectBySlug(slug);
    if (!project || !project.active) continue;
    try {
      schools[slug] = await syncSchool(project, { access, fetchImpl, now });
    } catch (err) {
      // Ключ один на все школы: чужой или отозванный — дальше спрашивать бессмысленно.
      if (err.status === 401 || err.status === 403) {
        setSetting('crm_segments_last_error', err.message);
        throw err;
      }
      errors.push(`${slug}: ${err.message}`);
    }
  }

  const sum = { added: 0, removed: 0, refused: 0, archived: 0, segments: 0 };
  for (const s of Object.values(schools)) for (const k of Object.keys(sum)) sum[k] += s[k] || 0;
  setSetting('crm_segments_last_stats', JSON.stringify({ ...sum, at: nowIso(now) }));
  if (sum.added || sum.removed || sum.archived) {
    log(
      'info',
      `рассылка: сегменты CRM — сегментов ${sum.segments}, новых в базах ${sum.added}, выбыло ${sum.removed}` +
        (sum.refused ? `, не взято отказавшихся ${sum.refused}` : '') +
        (sum.archived ? `, выключено ${sum.archived}` : '')
    );
  }
  if (errors.length) {
    const message = `Сегменты CRM не забрались — ${errors.join('; ')}`;
    setSetting('crm_segments_last_error', message);
    throw new Error(message);
  }
  setSetting('crm_segments_last_at', nowIso(now));
  setSetting('crm_segments_last_error', '');
  return { schools };
}
