/**
 * Базы, контакты, стоп-лист: чтение, поиск, правка, выгрузка.
 *
 * Два правила держат всё остальное:
 *   1. «Не слать» решает стоп-лист (`mail_suppressions`), а не состояние
 *      контакта. Состояние — только отражение для показа. Поэтому
 *      повторная загрузка не воскрешает отписанных, а стёртый человек не
 *      возвращается со следующим файлом.
 *   2. Ничего не удаляем из боевой базы: база уходит в архив, человек — из
 *      базы отметкой `removed_at`. Единственное настоящее удаление — «стереть
 *      по просьбе», его требует закон о персональных данных.
 */

import { db, log } from '../db.js';
import { CONSENT_BASES, CONTACT_STATUS, PAGE_SIZE, SUPPRESSION_REASONS } from './specs.js';
import { checkAddress, emailHash, maskEmail } from './import/address.js';

// Поиск без учёта регистра по кириллице: встроенные lower() и LIKE в SQLite
// понимают регистр только у латиницы, а имена в базах — «Ірина», «ОЛЕНА».
db.function('mail_has', { deterministic: true }, (text, needle) =>
  String(text ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase()) ? 1 : 0
);

// Подготовленные запросы кэшируются: загрузка базы на десятки тысяч строк
// иначе тратила бы время на разбор одного и того же SQL в каждой строке.
const statements = new Map();
function prepared(sql) {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export class MailError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/* ---------------------------------- базы ---------------------------------- */

function listFromRow(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    description: r.description,
    consentBasis: r.consent_basis,
    consentTitle: CONSENT_BASES[r.consent_basis]?.title || r.consent_basis,
    consentNote: r.consent_note,
    columns: parseJson(r.columns, []),
    createdAt: r.created_at,
    createdBy: r.created_by_name || null,
    archivedAt: r.archived_at,
    counts: r.total === undefined
      ? undefined
      : {
          total: r.total || 0,
          active: r.active || 0,
          unsubscribed: r.unsubscribed || 0,
          bounced: r.bounced || 0,
          invalid: r.invalid || 0,
        },
    lastImportAt: r.last_import_at || null,
  };
}

export function getList(id) {
  const row = prepared('SELECT * FROM mail_lists WHERE id = ?').get(Number(id));
  return row ? listFromRow(row) : null;
}

/** Базы школы со счётчиками — одним запросом, без обхода по базе. */
export function listLists(projectId, { includeArchived = false } = {}) {
  return db
    .prepare(
      `SELECT l.*, s.name AS created_by_name,
              COUNT(m.contact_id) AS total,
              SUM(c.status = 'active') AS active,
              SUM(c.status = 'unsubscribed') AS unsubscribed,
              SUM(c.status = 'bounced') AS bounced,
              SUM(c.status = 'invalid') AS invalid,
              (SELECT MAX(finished_at) FROM mail_imports i WHERE i.list_id = l.id AND i.status = 'done') AS last_import_at
         FROM mail_lists l
         LEFT JOIN mail_list_members m ON m.list_id = l.id AND m.removed_at IS NULL
         LEFT JOIN mail_contacts c ON c.id = m.contact_id
         LEFT JOIN staff s ON s.id = l.created_by
        WHERE l.project_id = ? AND (l.archived_at IS NULL OR ?)
        GROUP BY l.id
        ORDER BY l.archived_at IS NOT NULL, l.created_at DESC, l.id DESC`
    )
    .all(Number(projectId), includeArchived ? 1 : 0)
    .map(listFromRow);
}

/** Сводка по школе: сколько людей всего и в каком они состоянии. */
export function projectSummary(projectId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(status = 'active') AS active,
              SUM(status = 'unsubscribed') AS unsubscribed,
              SUM(status = 'bounced') AS bounced,
              SUM(status = 'invalid') AS invalid
         FROM mail_contacts WHERE project_id = ?`
    )
    .get(Number(projectId));
  const lists = db
    .prepare('SELECT COUNT(*) AS n FROM mail_lists WHERE project_id = ? AND archived_at IS NULL')
    .get(Number(projectId)).n;
  const lastImport = db
    .prepare("SELECT MAX(finished_at) AS at FROM mail_imports WHERE project_id = ? AND status = 'done'")
    .get(Number(projectId)).at;
  return {
    total: row.total || 0,
    active: row.active || 0,
    unsubscribed: row.unsubscribed || 0,
    bounced: row.bounced || 0,
    invalid: row.invalid || 0,
    lists,
    lastImportAt: lastImport || null,
  };
}

function cleanListFields({ name, description, consentBasis, consentNote }, { partial = false } = {}) {
  const out = {};
  if (!partial || name !== undefined) {
    const clean = String(name ?? '').trim().slice(0, 120);
    if (!clean) throw new MailError('Назовите базу');
    out.name = clean;
  }
  if (!partial || consentBasis !== undefined) {
    if (!CONSENT_BASES[consentBasis]) {
      throw new MailError('Выберите, на каком основании у школы эти адреса — без этого слать нельзя');
    }
    out.consent_basis = consentBasis;
  }
  if (description !== undefined) out.description = String(description).trim().slice(0, 500);
  if (consentNote !== undefined) out.consent_note = String(consentNote).trim().slice(0, 500);
  if (!partial && out.consent_basis === 'other' && !out.consent_note) {
    throw new MailError('Для основания «Другое» опишите, откуда адреса');
  }
  return out;
}

export function createList(projectId, fields, staffId = null) {
  const clean = cleanListFields(fields);
  const taken = db
    .prepare('SELECT id FROM mail_lists WHERE project_id = ? AND name = ?')
    .get(Number(projectId), clean.name);
  if (taken) throw new MailError(`База «${clean.name}» у этой школы уже есть`);
  const info = db
    .prepare(
      `INSERT INTO mail_lists (project_id, name, description, consent_basis, consent_note, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(projectId),
      clean.name,
      clean.description || '',
      clean.consent_basis,
      clean.consent_note || '',
      staffId
    );
  log('info', `рассылка: заведена база «${clean.name}»`);
  return getList(info.lastInsertRowid);
}

export function updateList(id, fields) {
  const list = getList(id);
  if (!list) throw new MailError('База не найдена', 404);
  const clean = cleanListFields(fields, { partial: true });
  if (clean.name && clean.name !== list.name) {
    const taken = db
      .prepare('SELECT id FROM mail_lists WHERE project_id = ? AND name = ? AND id != ?')
      .get(list.projectId, clean.name, list.id);
    if (taken) throw new MailError(`База «${clean.name}» у этой школы уже есть`);
  }
  const basis = clean.consent_basis ?? list.consentBasis;
  const note = clean.consent_note ?? list.consentNote;
  if (basis === 'other' && !note) throw new MailError('Для основания «Другое» опишите, откуда адреса');

  const sets = Object.keys(clean).map((k) => `${k} = ?`);
  if (fields.archived !== undefined) sets.push(`archived_at = ${fields.archived ? '?' : 'NULL'}`);
  if (!sets.length) return list;
  const params = Object.values(clean);
  if (fields.archived) params.push(nowIso());
  prepared(`UPDATE mail_lists SET ${sets.join(', ')} WHERE id = ?`).run(...params, list.id);
  if (fields.archived !== undefined && Boolean(fields.archived) !== Boolean(list.archivedAt)) {
    log('info', `рассылка: база «${list.name}» ${fields.archived ? 'убрана в архив' : 'возвращена из архива'}`);
  }
  return getList(list.id);
}

/** Добавить новые колонки к базе, сохранив порядок уже известных. */
export function mergeListColumns(listId, names) {
  const list = getList(listId);
  if (!list) return;
  const columns = [...list.columns];
  for (const n of names) if (n && !columns.includes(n)) columns.push(n);
  if (columns.length !== list.columns.length) {
    prepared('UPDATE mail_lists SET columns = ? WHERE id = ?').run(JSON.stringify(columns), listId);
  }
}

/* -------------------------------- контакты -------------------------------- */

function contactFromRow(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    email: r.email,
    name: r.name,
    status: r.status,
    statusTitle: CONTACT_STATUS[r.status] || r.status,
    statusNote: r.status_note || null,
    statusAt: r.status_at || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    attrs: r.attrs !== undefined ? parseJson(r.attrs, {}) : undefined,
    addedAt: r.added_at || undefined,
    listsCount: r.lists_count ?? undefined,
  };
}

export function getContactRow(id) {
  return prepared('SELECT * FROM mail_contacts WHERE id = ?').get(Number(id)) || null;
}

const SORTS = {
  added: 'added_at DESC, c.id DESC',
  email: 'c.email COLLATE NOCASE ASC',
  name: "c.name = '' , c.name COLLATE NOCASE ASC",
  status: "c.status = 'active', c.status, c.email",
};

/**
 * Содержимое базы (или всех контактов школы, если базы нет) постранично.
 *
 * @param {{projectId: number, listId?: number|null, q?: string, status?: string, page?: number, sort?: string}} opts
 */
export function listContacts({ projectId, listId = null, q = '', status = '', page = 1, sort = 'added' }) {
  const where = [];
  const params = [];
  let from;
  let select;

  if (listId) {
    from = 'mail_list_members m JOIN mail_contacts c ON c.id = m.contact_id';
    select = 'c.*, m.attrs, m.added_at';
    where.push('m.list_id = ?', 'm.removed_at IS NULL');
    params.push(Number(listId));
  } else {
    from = 'mail_contacts c';
    select = `c.*, c.created_at AS added_at,
      (SELECT COUNT(*) FROM mail_list_members mm WHERE mm.contact_id = c.id AND mm.removed_at IS NULL) AS lists_count`;
    where.push('c.project_id = ?');
    params.push(Number(projectId));
  }

  if (status === 'undeliverable') where.push("c.status IN ('bounced', 'invalid')");
  else if (CONTACT_STATUS[status]) {
    where.push('c.status = ?');
    params.push(status);
  }
  const needle = String(q || '').trim();
  if (needle) {
    where.push('(mail_has(c.email, ?) OR mail_has(c.name, ?))');
    params.push(needle, needle);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = prepared(`SELECT COUNT(*) AS n FROM ${from} ${whereSql}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const order = SORTS[sort] || SORTS.added;

  const rows = db
    .prepare(`SELECT ${select} FROM ${from} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (current - 1) * PAGE_SIZE)
    .map(contactFromRow);

  // Счётчики для фильтров — по той же базе, без учёта самого фильтра состояния.
  const baseWhere = listId ? 'm.list_id = ? AND m.removed_at IS NULL' : 'c.project_id = ?';
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(c.status = 'active') AS active, SUM(c.status = 'unsubscribed') AS unsubscribed,
              SUM(c.status IN ('bounced', 'invalid')) AS undeliverable
         FROM ${from} WHERE ${baseWhere}`
    )
    .get(listId ? Number(listId) : Number(projectId));

  return {
    contacts: rows,
    total,
    page: current,
    pages,
    pageSize: PAGE_SIZE,
    counts: {
      total: counts.total || 0,
      active: counts.active || 0,
      unsubscribed: counts.unsubscribed || 0,
      undeliverable: counts.undeliverable || 0,
    },
  };
}

/** Карточка: человек, его базы и основание попадания в каждую. */
export function getContact(id) {
  const row = getContactRow(id);
  if (!row) return null;
  const contact = contactFromRow(row);
  contact.memberships = db
    .prepare(
      `SELECT m.list_id, m.attrs, m.added_at, m.removed_at, l.name, l.consent_basis, l.archived_at,
              i.source_name, s.name AS added_by_name
         FROM mail_list_members m
         JOIN mail_lists l ON l.id = m.list_id
         LEFT JOIN mail_imports i ON i.id = m.import_id
         LEFT JOIN staff s ON s.id = m.added_by
        WHERE m.contact_id = ?
        ORDER BY m.removed_at IS NOT NULL, m.added_at DESC`
    )
    .all(contact.id)
    .map((m) => ({
      listId: m.list_id,
      listName: m.name,
      listArchived: Boolean(m.archived_at),
      consentTitle: CONSENT_BASES[m.consent_basis]?.title || m.consent_basis,
      attrs: parseJson(m.attrs, {}),
      addedAt: m.added_at,
      removedAt: m.removed_at,
      source: m.source_name ? `загрузка «${m.source_name}»` : m.added_by_name ? `вручную: ${m.added_by_name}` : 'вручную',
    }));
  const suppression = db
    .prepare('SELECT reason, note, created_at FROM mail_suppressions WHERE project_id = ? AND email_hash = ?')
    .get(contact.projectId, emailHash(contact.email));
  contact.suppression = suppression
    ? { reason: suppression.reason, title: SUPPRESSION_REASONS[suppression.reason] || suppression.reason, note: suppression.note, at: suppression.created_at }
    : null;
  return contact;
}

export function isSuppressed(projectId, email) {
  return Boolean(
    prepared('SELECT 1 FROM mail_suppressions WHERE project_id = ? AND email_hash = ?').get(Number(projectId), emailHash(email))
  );
}

/**
 * Найти или завести контакт. Непустое имя не затирается: человек мог
 * поправить его руками, а в следующем файле оно записано иначе.
 * @returns {{id: number, created: boolean}}
 */
export function upsertContact(projectId, email, name = '') {
  const existing = prepared('SELECT id, name FROM mail_contacts WHERE project_id = ? AND email = ?').get(Number(projectId), email);
  if (existing) {
    if (!existing.name && name) {
      prepared('UPDATE mail_contacts SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), existing.id);
    }
    return { id: existing.id, created: false };
  }
  const info = db
    .prepare('INSERT INTO mail_contacts (project_id, email, name) VALUES (?, ?, ?)')
    .run(Number(projectId), email, String(name || '').slice(0, 200));
  return { id: Number(info.lastInsertRowid), created: true };
}

/**
 * Членство в базе. Убранный раньше человек возвращается, колонки файла
 * дополняются новыми значениями.
 * @returns {'added'|'existed'}
 */
export function addMembership(listId, contactId, { attrs = {}, importId = null, staffId = null } = {}) {
  const row = prepared('SELECT attrs, removed_at FROM mail_list_members WHERE list_id = ? AND contact_id = ?').get(listId, contactId);
  if (!row) {
    prepared(
      'INSERT INTO mail_list_members (list_id, contact_id, attrs, import_id, added_by) VALUES (?, ?, ?, ?, ?)'
    ).run(listId, contactId, JSON.stringify(attrs), importId, staffId);
    return 'added';
  }
  const merged = { ...parseJson(row.attrs, {}), ...Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== '')) };
  if (row.removed_at) {
    prepared(
      `UPDATE mail_list_members SET removed_at = NULL, attrs = ?, added_at = ?, import_id = ?, added_by = ?
        WHERE list_id = ? AND contact_id = ?`
    ).run(JSON.stringify(merged), nowIso(), importId, staffId, listId, contactId);
    return 'added';
  }
  prepared('UPDATE mail_list_members SET attrs = ? WHERE list_id = ? AND contact_id = ?').run(JSON.stringify(merged), listId, contactId);
  return 'existed';
}

/** Добавить адрес руками. Проверка та же, что у загрузки, — но без поблажек. */
export function addContactManually({ listId, email, name = '', staffId = null }) {
  const list = getList(listId);
  if (!list) throw new MailError('База не найдена', 404);
  if (list.archivedAt) throw new MailError('База в архиве — верните её, чтобы добавлять адреса');

  const check = checkAddress(email);
  if (check.verdict === 'invalid') throw new MailError(`Адрес не подходит: ${check.issues.join(', ')}`);
  if (check.verdict === 'fixable') {
    throw new MailError(`Проверьте адрес: ${check.issues.join(', ')}. Возможно, ${check.suggestion}`);
  }
  if (isSuppressed(list.projectId, check.email)) {
    throw new MailError('Этот адрес в стоп-листе школы. Если человек сам попросил вернуть письма — найдите его во «Всех контактах» и верните подписку');
  }

  let result;
  db.exec('BEGIN');
  try {
    const contact = upsertContact(list.projectId, check.email, String(name).trim());
    result = { contactId: contact.id, created: contact.created, membership: addMembership(list.id, contact.id, { staffId }) };
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ...result, warnings: check.issues };
}

export function updateContact(id, { name, email }) {
  const row = getContactRow(id);
  if (!row) throw new MailError('Контакт не найден', 404);
  const sets = [];
  const params = [];
  if (name !== undefined) {
    sets.push('name = ?');
    params.push(String(name).trim().slice(0, 200));
  }
  if (email !== undefined && String(email).trim().toLowerCase() !== row.email) {
    const check = checkAddress(email);
    if (check.verdict === 'invalid' || check.verdict === 'fixable') {
      throw new MailError(`Адрес не подходит: ${check.issues.join(', ')}${check.suggestion ? `. Возможно, ${check.suggestion}` : ''}`);
    }
    const taken = prepared('SELECT id FROM mail_contacts WHERE project_id = ? AND email = ? AND id != ?').get(row.project_id, check.email, row.id);
    if (taken) throw new MailError('Такой адрес в школе уже есть — это другой контакт');
    if (isSuppressed(row.project_id, check.email)) throw new MailError('Новый адрес в стоп-листе школы');
    sets.push('email = ?');
    params.push(check.email);
  }
  if (!sets.length) return getContact(id);
  sets.push('updated_at = ?');
  params.push(nowIso());
  prepared(`UPDATE mail_contacts SET ${sets.join(', ')} WHERE id = ?`).run(...params, row.id);
  return getContact(id);
}

export function updateMemberAttrs(listId, contactId, attrs) {
  const clean = Object.fromEntries(
    Object.entries(attrs || {}).map(([k, v]) => [String(k).slice(0, 80), String(v ?? '').slice(0, 500)])
  );
  const info = db
    .prepare('UPDATE mail_list_members SET attrs = ? WHERE list_id = ? AND contact_id = ? AND removed_at IS NULL')
    .run(JSON.stringify(clean), Number(listId), Number(contactId));
  if (!info.changes) throw new MailError('Контакта нет в этой базе', 404);
  mergeListColumns(Number(listId), Object.keys(clean));
}

/* ------------------------------ стоп-лист ------------------------------ */

const STATUS_BY_REASON = { unsubscribed: 'unsubscribed', manual: 'unsubscribed', bounced: 'bounced', invalid: 'invalid' };

function suppress(row, reason, note = null) {
  prepared(
    `INSERT INTO mail_suppressions (project_id, email_hash, reason, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, email_hash) DO UPDATE SET reason = excluded.reason, note = excluded.note`
  ).run(row.project_id, emailHash(row.email), reason, note);
  const status = STATUS_BY_REASON[reason];
  if (status) {
    const at = nowIso();
    prepared('UPDATE mail_contacts SET status = ?, status_note = ?, status_at = ?, updated_at = ? WHERE id = ?').run(
      status,
      note,
      at,
      at,
      row.id
    );
  }
}

/* ---------------------------- массовые действия ---------------------------- */

/**
 * @param {{projectId: number, ids: number[], action: string, listId?: number, targetListId?: number, note?: string}} opts
 * @returns {{done: number}}
 */
export function bulk({ projectId, ids, action, listId = null, targetListId = null, note = '' }) {
  const clean = [...new Set((ids || []).map(Number).filter(Boolean))].slice(0, 5000);
  if (!clean.length) throw new MailError('Не выбрано ни одного контакта');

  const rows = clean.map(getContactRow).filter((r) => r && r.project_id === Number(projectId));
  if (rows.length !== clean.length) throw new MailError('Часть контактов не найдена или из другой школы', 404);

  const target = targetListId ? getList(targetListId) : null;
  if (['copy', 'move'].includes(action)) {
    if (!target || target.projectId !== Number(projectId)) throw new MailError('Выберите базу этой школы');
    if (target.archivedAt) throw new MailError('База в архиве — верните её, чтобы добавлять адреса');
  }
  const source = listId ? getList(listId) : null;
  if (['remove', 'move'].includes(action) && (!source || source.projectId !== Number(projectId))) {
    throw new MailError('Не указано, из какой базы убирать');
  }

  let done = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (action === 'remove' || action === 'move') {
        const info = db
          .prepare('UPDATE mail_list_members SET removed_at = ? WHERE list_id = ? AND contact_id = ? AND removed_at IS NULL')
          .run(nowIso(), source.id, row.id);
        if (action === 'remove') done += info.changes;
      }
      if (action === 'copy' || action === 'move') {
        const attrs = source
          ? parseJson(prepared('SELECT attrs FROM mail_list_members WHERE list_id = ? AND contact_id = ?').get(source.id, row.id)?.attrs, {})
          : {};
        if (addMembership(target.id, row.id, { attrs }) === 'added') done++;
        mergeListColumns(target.id, Object.keys(attrs));
      }
      if (action === 'unsubscribe' || action === 'bounced') {
        if (row.status === 'active' || action === 'bounced') done++;
        suppress(row, action === 'bounced' ? 'bounced' : 'manual', String(note || '').trim().slice(0, 300) || null);
      }
      if (!['remove', 'move', 'copy', 'unsubscribe', 'bounced'].includes(action)) {
        throw new MailError('Неизвестное действие');
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const word = {
    remove: `убрано из базы «${source?.name}»`,
    move: `перенесено из «${source?.name}» в «${target?.name}»`,
    copy: `скопировано в базу «${target?.name}»`,
    unsubscribe: 'отписано вручную',
    bounced: 'отмечено «адрес не существует»',
  }[action];
  log('info', `рассылка: ${word} — ${done} из ${rows.length}`);
  return { done };
}

/** Вернуть подписку — только с причиной: это решение против стоп-листа. */
export function resubscribe(id, note) {
  const row = getContactRow(id);
  if (!row) throw new MailError('Контакт не найден', 404);
  const reason = String(note || '').trim();
  if (!reason) throw new MailError('Напишите, почему возвращаете подписку — например, «попросил сам по телефону»');
  db.exec('BEGIN');
  try {
    prepared('DELETE FROM mail_suppressions WHERE project_id = ? AND email_hash = ?').run(row.project_id, emailHash(row.email));
    const at = nowIso();
    prepared("UPDATE mail_contacts SET status = 'active', status_note = ?, status_at = ?, updated_at = ? WHERE id = ?").run(
      reason.slice(0, 300),
      at,
      at,
      row.id
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  log('warn', `рассылка: подписка возвращена ${maskEmail(row.email)} — ${reason.slice(0, 120)}`);
  return getContact(id);
}

/**
 * Стереть по просьбе человека. Строка контакта и членства уходят, в стоп-листе
 * остаётся хеш адреса — иначе следующий файл вернул бы человека обратно.
 */
export function erase(id) {
  const row = getContactRow(id);
  if (!row) throw new MailError('Контакт не найден', 404);
  db.exec('BEGIN');
  try {
    prepared(
      `INSERT INTO mail_suppressions (project_id, email_hash, reason, note) VALUES (?, ?, 'erased', NULL)
       ON CONFLICT(project_id, email_hash) DO UPDATE SET reason = 'erased', note = NULL`
    ).run(row.project_id, emailHash(row.email));
    prepared('DELETE FROM mail_contacts WHERE id = ?').run(row.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  log('warn', `рассылка: контакт стёрт по просьбе (${maskEmail(row.email)}), адрес остался в стоп-листе хешем`);
}

/* -------------------------------- выгрузка -------------------------------- */

/**
 * Ячейка для Excel. Текст, начинающийся с `=`, `+`, `-`, `@`, Excel выполнит
 * как формулу — выгрузка базы не должна становиться способом что-то запустить
 * на компьютере того, кто её откроет.
 */
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 с BOM и «;» — чтобы Excel открыл кириллицу без мастера импорта. */
export function exportCsv({ projectId, listId = null }) {
  const list = listId ? getList(listId) : null;
  const columns = list ? list.columns : [];
  const header = ['Email', 'Имя', 'Состояние', 'Добавлен', ...columns];
  const lines = [header.map(csvCell).join(';')];

  const rows = list
    ? db
        .prepare(
          `SELECT c.email, c.name, c.status, m.added_at, m.attrs FROM mail_list_members m
             JOIN mail_contacts c ON c.id = m.contact_id
            WHERE m.list_id = ? AND m.removed_at IS NULL ORDER BY m.added_at, c.id`
        )
        .all(list.id)
    : prepared('SELECT email, name, status, created_at AS added_at FROM mail_contacts WHERE project_id = ? ORDER BY id').all(Number(projectId));

  for (const r of rows) {
    const attrs = r.attrs ? parseJson(r.attrs, {}) : {};
    lines.push(
      [r.email, r.name, CONTACT_STATUS[r.status] || r.status, String(r.added_at || '').slice(0, 10), ...columns.map((c) => attrs[c] ?? '')]
        .map(csvCell)
        .join(';')
    );
  }
  log('info', `рассылка: выгружена ${list ? `база «${list.name}»` : 'вся база школы'} — ${rows.length} адресов`);
  return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, count: rows.length, name: list ? list.name : 'все контакты' };
}
