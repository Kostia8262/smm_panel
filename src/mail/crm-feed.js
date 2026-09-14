/**
 * Лента согласий из CRM школы → базы рассылки.
 *
 * Люди, давшие согласие на письма в админке (галочка на странице «Дякуємо»,
 * согласие, записанное менеджером в карточке), приходят в панель сами: воркер
 * раз в минуту спрашивает у админки «какие адреса менялись после seq N».
 *
 *   — лента по адресам: в пачке адрес один раз, с текущим состоянием;
 *   — есть согласие → адрес в базе «CRM школы» своей школы (заявка или клиент);
 *   — согласия больше нет (consent: null) → адрес убирается из этих баз, но
 *     НЕ в стоп-лист: снятая галочка чаще опечатка в адресе, чем «не пишите».
 *     Стоп-лист — только отписка в самой панели;
 *   — отказ сильнее ленты: отписавшийся, стёртый, недоставляемый адрес лента
 *     не возвращает;
 *   — повтор безопасен: ключ — школа + адрес, курсор двигается вместе с пачкой.
 *
 * Контракт (вкладка админки, 14.09.2026):
 *   GET /api/integration/mail/feed?after=<seq>&limit=500, x-integration-key со
 *   скоупом mail:feed (отдельный ключ, не leads:read) →
 *   { items: [{ seq, email, consent: {at, version, source}|null,
 *               person: {kind, id, childName, status, course, site, lang}|null }],
 *     next, hasMore }
 */

import { db, log } from '../db.js';
import { getSetting, setSetting } from '../staff.js';
import { getProjectBySlug } from '../projects.js';
import { decrypt } from '../secrets.js';
import * as store from './store.js';
import { checkAddress } from './import/address.js';

export const FEED_PAGE = 500;
export const FEED_SCOPE = 'mail:feed';
/** Пачек за один заход: большой хвост догоняется частями, не держа воркер. */
const MAX_PAGES = 20;
const CONSENT_VERSION = /^[a-z0-9][a-z0-9._-]{0,59}$/i;

/** Откуда согласие → основание базы. */
const BASIS_BY_SOURCE = { thank_you: 'lead', manager: 'client' };
const BASES = ['lead', 'client'];
const LIST_NAMES = { lead: 'CRM школы — заявки', client: 'CRM школы — клиенты' };
const LIST_NOTES = {
  lead: 'Оставили заявку и отметили согласие на письма. Приходят из админки школы сами, снятое согласие убирает адрес из базы',
  client: 'Клиенты, согласие которых записал менеджер. Приходят из админки школы сами, снятое согласие убирает адрес из базы',
};
/** Колонки базы — для будущих сегментов. */
const COLUMNS = ['CRM id', 'Кто', 'Ребёнок', 'Статус', 'Курс', 'Сайт', 'Язык'];

/** Ключ ленты — отдельный от ключа заявок: у него другое право. */
export function feedAccess() {
  const stored = getSetting('crm_feed_token', '');
  let apiKey = '';
  if (stored) {
    try {
      apiKey = decrypt(stored);
    } catch {
      apiKey = '';
    }
  }
  return { apiUrl: getSetting('leads_api_url', 'https://mycomputer.education'), apiKey };
}

export function feedState() {
  let lastStats = null;
  try {
    lastStats = JSON.parse(getSetting('crm_feed_last_stats', '') || 'null');
  } catch {
    lastStats = null;
  }
  return {
    hasToken: Boolean(getSetting('crm_feed_token', '')),
    cursor: getSetting('crm_feed_cursor', '') || null,
    lastAt: getSetting('crm_feed_last_at', '') || null,
    lastError: getSetting('crm_feed_last_error', '') || null,
    lastStats,
  };
}

/**
 * Школа по домену заявки. Порядок важен: child — поддомен .education.
 * Пустой сайт (клиент заведён руками) — академия.
 */
export function projectSlugOfSite(site) {
  const host = String(site || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/:?#].*$/, '')
    .replace(/^www\./, '');
  if (!host) return 'education';
  if (host === 'child.mycomputer.education') return 'child';
  if (host === 'mycomputer.education' || host.endsWith('.mycomputer.education')) return 'education';
  if (host === 'mycomputer.school' || host.endsWith('.mycomputer.school')) return 'school';
  if (host === 'fluent-fox.site' || host.endsWith('.fluent-fox.site')) return 'fluentfox';
  return null;
}

/** Базы ленты уже заведённые — без создания: снимать согласие можно только оттуда, где адрес был. */
function existingFeedLists(projectId = null) {
  const ids = [];
  for (const row of db.prepare("SELECT key, value FROM settings WHERE key LIKE 'crm_feed_list_%'").all()) {
    const m = /^crm_feed_list_(\d+)_(lead|client)$/.exec(row.key);
    if (m && (projectId === null || Number(m[1]) === projectId) && Number(row.value)) ids.push(Number(row.value));
  }
  return ids;
}

/** База ленты для школы и основания; архивированную не воскрешаем — заводим новую. */
function feedList(projectId, basis) {
  const key = `crm_feed_list_${projectId}_${basis}`;
  const id = Number(getSetting(key, '')) || null;
  const existing = id ? store.getList(id) : null;
  if (existing && existing.projectId === projectId && !existing.archivedAt) return existing;
  const same = db.prepare('SELECT id, archived_at FROM mail_lists WHERE project_id = ? AND name = ?').get(projectId, LIST_NAMES[basis]);
  let list;
  if (same && !same.archived_at) {
    list = store.getList(same.id);
  } else {
    const name = same ? `${LIST_NAMES[basis]} · ${new Date().toISOString().slice(0, 10)}` : LIST_NAMES[basis];
    list = store.createList(projectId, { name, consentBasis: basis, description: LIST_NOTES[basis] });
  }
  store.mergeListColumns(list.id, COLUMNS);
  setSetting(key, String(list.id));
  return list;
}

/** Убрать адрес из баз ленты (все школы или одна), не трогая стоп-лист и остальные базы. */
function removeFromFeedLists(email, listIds) {
  if (!listIds.length) return 0;
  const marks = listIds.map(() => '?').join(',');
  return Number(
    db
      .prepare(
        `UPDATE mail_list_members SET removed_at = ?
          WHERE removed_at IS NULL AND list_id IN (${marks})
            AND contact_id IN (SELECT id FROM mail_contacts WHERE email = ?)`
      )
      .run(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...listIds, email).changes
  );
}

/**
 * Одна запись ленты.
 * @returns {'added'|'updated'|'removed'|'absent'|'invalid'|'unknown_site'|'refused'}
 */
export function applyItem(item) {
  const email = String(item?.email || '').trim().toLowerCase();
  const consent = item?.consent;

  /* ---- согласия больше нет: убрать из баз ленты во всех школах ---- */
  if (!consent) return removeFromFeedLists(email, existingFeedLists()) ? 'removed' : 'absent';

  const person = item.person || {};
  const basis = BASIS_BY_SOURCE[consent.source];
  if (!basis || !consent.at || Number.isNaN(Date.parse(consent.at)) || !CONSENT_VERSION.test(String(consent.version || ''))) {
    return 'invalid';
  }
  const check = checkAddress(email);
  if (check.verdict !== 'ok' && check.verdict !== 'warning') return 'invalid';
  const slug = projectSlugOfSite(person.site);
  const project = slug ? getProjectBySlug(slug) : null;
  if (!project || !project.active) return 'unknown_site';
  const address = check.email;

  // Школа сменилась (заявку перенесли) — из баз ленты других школ адрес уходит.
  removeFromFeedLists(address, existingFeedLists().filter((id) => !existingFeedLists(project.id).includes(id)));

  const contact = db.prepare('SELECT id, status FROM mail_contacts WHERE project_id = ? AND email = ?').get(project.id, address);
  if (store.isSuppressed(project.id, address) || (contact && contact.status !== 'active')) return 'refused';

  const list = feedList(project.id, basis);
  // Основание одно: заявка стала клиентом — из базы заявок адрес уходит.
  const other = BASES.filter((b) => b !== basis).map((b) => Number(getSetting(`crm_feed_list_${project.id}_${b}`, ''))).filter(Boolean);
  removeFromFeedLists(address, other);

  const attrs = {
    'CRM id': String(person.id ?? ''),
    Кто: person.kind === 'client' ? 'клиент' : person.kind === 'lead' ? 'заявка' : '',
    Ребёнок: String(person.childName || '').trim().slice(0, 100),
    Статус: String(person.status || ''),
    Курс: String(person.course || ''),
    Сайт: String(person.site || ''),
    Язык: person.lang === 'ru' || person.lang === 'uk' ? person.lang : '',
  };
  // Имя в CRM — имя ребёнка, родителя там нет вовсе: в имя контакта его не кладём,
  // иначе родитель Оли получит «Вітаємо, Оля». {{name}} уйдёт в запасное слово.
  const contactId = store.upsertContact(project.id, address, '').id;
  if (store.addMembership(list.id, contactId, { attrs }) !== 'added') return 'updated';
  db.prepare("INSERT INTO mail_events (project_id, contact_id, type, source, note) VALUES (?, ?, 'subscribed', 'crm', ?)").run(
    project.id,
    contactId,
    `${consent.source} · ${consent.version} · ${consent.at}`
  );
  return 'added';
}

/** Пачка целиком в одной транзакции: курсор не обгоняет записанное. */
function applyPage(items, next) {
  const stats = {};
  db.exec('BEGIN');
  try {
    for (const item of items) {
      const outcome = applyItem(item);
      stats[outcome] = (stats[outcome] || 0) + 1;
    }
    if (next !== null && next !== undefined && next !== '') setSetting('crm_feed_cursor', String(next));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return stats;
}

async function integrationFetch(path, { apiUrl, apiKey, fetchImpl = globalThis.fetch }) {
  if (!apiUrl || !apiKey) throw new Error('Не вписан ключ ленты согласий');
  let res;
  try {
    res = await fetchImpl(`${apiUrl.replace(/\/$/, '')}${path}`, {
      headers: { 'x-integration-key': apiKey },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`Админка школы не ответила: ${err.message}`);
  }
  if (res.status === 401) throw new Error('Админка не узнала ключ ленты — вставьте ключ из «Інтеграції» (mcai_…)');
  if (res.status === 403) throw new Error(`Ключ ленты отозван или без права ${FEED_SCOPE} — выпустите новый в админке`);
  if (res.status === 404) throw new Error('В админке ещё нет ленты согласий');
  if (!res.ok) throw new Error(`Админка школы ответила ${res.status}`);
  return res.json();
}

/** «Проверить ленту»: ключ жив и у него право mail:feed. */
export async function pingFeed(access = feedAccess(), fetchImpl) {
  const data = await integrationFetch('/api/integration/ping', { ...access, fetchImpl });
  const scopes = Array.isArray(data.scopes) ? data.scopes : [];
  if (!scopes.includes(FEED_SCOPE)) throw new Error(`У ключа нет права ${FEED_SCOPE} — выпустите ключ «SMM-панель — стрічка» с этим правом`);
  return { name: data.name || '', scopes };
}

/**
 * Один заход воркера: дочитать ленту, пока админка говорит hasMore.
 * @returns {Promise<{pages: number, stats: object}|null>} null — ключ не вписан
 */
export async function pullFeed({ access = feedAccess(), fetchImpl, now = Date.now() } = {}) {
  if (!access.apiKey) return null;
  const total = {};
  let pages = 0;
  try {
    while (pages < MAX_PAGES) {
      const after = getSetting('crm_feed_cursor', '') || '0';
      const data = await integrationFetch(`/api/integration/mail/feed?after=${encodeURIComponent(after)}&limit=${FEED_PAGE}`, { ...access, fetchImpl });
      if (!Array.isArray(data?.items)) throw new Error('Лента пришла без списка items');
      pages++;
      const stats = applyPage(data.items, data.next);
      for (const [k, v] of Object.entries(stats)) total[k] = (total[k] || 0) + v;
      if (!data.hasMore || !data.items.length || String(data.next) === String(after)) break;
    }
  } catch (err) {
    setSetting('crm_feed_last_error', err.message);
    throw err;
  }
  setSetting('crm_feed_last_at', new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  setSetting('crm_feed_last_error', '');
  if (Object.keys(total).length) {
    setSetting('crm_feed_last_stats', JSON.stringify({ ...total, at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') }));
    const skipped = (total.invalid || 0) + (total.unknown_site || 0) + (total.refused || 0);
    if (total.added || total.removed || skipped) {
      log(
        'info',
        `рассылка: лента CRM — новых в базах ${total.added || 0}, снято согласие ${total.removed || 0}, обновлено ${total.updated || 0}` +
          (skipped ? `, не взято ${skipped} (отказывались ${total.refused || 0}, ошибка записи ${total.invalid || 0}, чужой сайт ${total.unknown_site || 0})` : '')
      );
    }
  }
  return { pages, stats: total };
}
