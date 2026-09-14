/**
 * Доступ админки школы к панели — только чтение (мост «CRM ↔ панель», фаза 4).
 *
 * Админка показывает у себя страницу «Розсилки» (подписчики и кто они в CRM)
 * и статус подписки в карточке клиента. Ходит со своего сервера с ключом,
 * который выпускает владелец панели:
 *
 *   — ключ показывается один раз, в базе sha256 и хвост для узнавания;
 *   — отзыв вместо удаления, видно последнее использование;
 *   — 401 — ключа нет или он чужой, 403 — отозван;
 *   — наружу уходят адрес, состояние, базы, происхождение, даты писем.
 *     Имён, телефонов, текстов писем и ссылок отписки здесь нет.
 *
 * Эндпоинты (все под /api/integration/crm/, `project` — slug школы):
 *   GET  projects
 *   GET  summary?project=
 *   GET  contacts?project=&q=&status=&source=&list=&page=&perPage=
 *   POST contacts/status { project, emails: [...] } — до 200 адресов
 */

import { randomBytes, createHash } from 'node:crypto';
import express from 'express';
import { db, log } from '../db.js';
import { listProjects, getProjectBySlug } from '../projects.js';
import { tooManyAttempts, clearAttempts } from '../ratelimit.js';
import { CONTACT_STATUS } from './specs.js';

const KEY_PREFIX = 'smmk_';
const STATUS_BATCH = 200;
const PER_PAGE_MAX = 100;
const USE_TOUCH_MS = 60 * 1000;
export const MEMBER_SOURCES = ['form', 'crm_feed', 'import', 'manual'];

const iso = (at = Date.now()) => new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

/* --------------------------------- ключи --------------------------------- */

function keyFromRow(r) {
  return {
    id: r.id,
    name: r.name,
    tail: r.tail,
    createdAt: r.created_at,
    createdBy: r.created_by_name || null,
    revokedAt: r.revoked_at || null,
    lastUsedAt: r.last_used_at || null,
  };
}

export function listKeys() {
  return db
    .prepare(
      `SELECT k.*, s.name AS created_by_name FROM crm_access_keys k LEFT JOIN staff s ON s.id = k.created_by
        ORDER BY k.revoked_at IS NOT NULL, k.id DESC`
    )
    .all()
    .map(keyFromRow);
}

/** @returns {{key: string, item: object}} открытый ключ — только в этом ответе */
export function issueKey(name, staffId = null) {
  const clean = String(name || '').trim().slice(0, 80) || 'Админка школы';
  const key = `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  const info = db
    .prepare('INSERT INTO crm_access_keys (name, key_hash, tail, created_by) VALUES (?, ?, ?, ?)')
    .run(clean, sha256(key), key.slice(-4), staffId);
  log('warn', `доступ админки школы: выпущен ключ «${clean}» (…${key.slice(-4)})`);
  const row = db.prepare('SELECT * FROM crm_access_keys WHERE id = ?').get(Number(info.lastInsertRowid));
  return { key, item: keyFromRow(row) };
}

export function revokeKey(id) {
  const row = db.prepare('SELECT * FROM crm_access_keys WHERE id = ?').get(Number(id));
  if (!row) return null;
  if (!row.revoked_at) {
    db.prepare('UPDATE crm_access_keys SET revoked_at = ? WHERE id = ?').run(iso(), row.id);
    log('warn', `доступ админки школы: отозван ключ «${row.name}» (…${row.tail})`);
  }
  return keyFromRow(db.prepare('SELECT * FROM crm_access_keys WHERE id = ?').get(row.id));
}

/** @returns {{status: 200|401|403, id?: number}} */
export function authenticate(raw, { ip = '', now = Date.now() } = {}) {
  const key = String(raw || '').trim();
  if (!key) return { status: 401 };
  const row = db.prepare('SELECT id, revoked_at, last_used_at FROM crm_access_keys WHERE key_hash = ?').get(sha256(key));
  if (!row) return { status: 401 };
  if (row.revoked_at) return { status: 403 };
  // Отметка использования — не чаще раза в минуту: админка ходит пачками.
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > USE_TOUCH_MS) {
    db.prepare('UPDATE crm_access_keys SET last_used_at = ?, last_ip = ? WHERE id = ?').run(iso(now), String(ip).slice(0, 64), row.id);
  }
  return { status: 200, id: row.id };
}

/* ------------------------------- происхождение ------------------------------ */

/** Базы, которые завели форма сайта и лента CRM: их id лежат в настройках. */
function specialLists() {
  const form = new Set();
  const feed = new Set();
  for (const r of db.prepare("SELECT key, value FROM settings WHERE key LIKE 'mail_signup_list_%' OR key LIKE 'crm_feed_list_%'").all()) {
    const id = Number(r.value);
    if (!id) continue;
    (r.key.startsWith('mail_signup_list_') ? form : feed).add(id);
  }
  return { form, feed };
}

/** SQL-выражение происхождения членства `m` — одно на все запросы. */
function sourceSql({ form, feed }) {
  const list = (set) => (set.size ? [...set].map(Number).join(',') : '-1');
  return `CASE WHEN m.import_id IS NOT NULL THEN 'import'
               WHEN m.list_id IN (${list(feed)}) THEN 'crm_feed'
               WHEN m.list_id IN (${list(form)}) THEN 'form'
               ELSE 'manual' END`;
}

/* --------------------------------- ответы --------------------------------- */

export function projectsPayload() {
  return { projects: listProjects().map((p) => ({ slug: p.slug, title: p.title })) };
}

export function summary(project, now = Date.now()) {
  const pid = project.id;
  const totals = { contacts: 0 };
  for (const s of Object.keys(CONTACT_STATUS)) totals[s] = 0;
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM mail_contacts WHERE project_id = ? GROUP BY status').all(pid)) {
    totals.contacts += r.n;
    totals[r.status] = (totals[r.status] || 0) + r.n;
  }
  const lists = db
    .prepare(
      `SELECT l.id, l.name, l.consent_basis,
              COUNT(m.contact_id) AS total,
              SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END) AS active
         FROM mail_lists l
         LEFT JOIN mail_list_members m ON m.list_id = l.id AND m.removed_at IS NULL
         LEFT JOIN mail_contacts c ON c.id = m.contact_id
        WHERE l.project_id = ? AND l.archived_at IS NULL
        GROUP BY l.id ORDER BY l.id`
    )
    .all(pid)
    .map((r) => ({ id: r.id, name: r.name, consentBasis: r.consent_basis, active: r.active || 0, total: r.total }));

  const sources = Object.fromEntries(MEMBER_SOURCES.map((s) => [s, { active: 0, total: 0 }]));
  const rows = db
    .prepare(
      `SELECT src, COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM (
         SELECT DISTINCT ${sourceSql(specialLists())} AS src, c.id, c.status
           FROM mail_list_members m JOIN mail_contacts c ON c.id = m.contact_id
          WHERE c.project_id = ? AND m.removed_at IS NULL)
        GROUP BY src`
    )
    .all(pid);
  for (const r of rows) sources[r.src] = { active: r.active || 0, total: r.total };

  const since = iso(now - 30 * 86400000);
  const signupsBySite = db
    .prepare(
      `SELECT site, COUNT(*) AS total, SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS last30
         FROM mail_signups WHERE project_id = ? AND status = 'subscribed' AND site != ''
        GROUP BY site ORDER BY total DESC`
    )
    .all(since, pid)
    .map((r) => ({ site: r.site, total: r.total, last30: r.last30 || 0 }));

  return { project: project.slug, totals, lists, sources, signupsBySite, updatedAt: iso(now) };
}

/** Базы, сайт и письма для пачки контактов — тремя запросами на всю страницу. */
function decorate(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const src = sourceSql(specialLists());
  const lists = new Map(ids.map((id) => [id, []]));
  const sites = new Map();
  for (const m of db
    .prepare(
      `SELECT m.contact_id, m.list_id, l.name, m.added_at, m.attrs, ${src} AS source
         FROM mail_list_members m JOIN mail_lists l ON l.id = m.list_id
        WHERE m.contact_id IN (${marks}) AND m.removed_at IS NULL ORDER BY m.added_at DESC`
    )
    .all(...ids)) {
    lists.get(m.contact_id).push({ id: m.list_id, name: m.name, addedAt: m.added_at, source: m.source });
    if (m.source === 'crm_feed' && !sites.has(m.contact_id)) {
      try {
        const site = JSON.parse(m.attrs || '{}')['Сайт'];
        if (site) sites.set(m.contact_id, site);
      } catch {
        // Колонки без сайта — не беда.
      }
    }
  }
  // Сайт формы точнее сайта заявки: человек сам подписался именно там.
  for (const s of db
    .prepare(
      `SELECT contact_id, site FROM mail_signups WHERE contact_id IN (${marks}) AND status = 'subscribed' AND site != ''
        ORDER BY created_at ASC`
    )
    .all(...ids)) {
    sites.set(s.contact_id, s.site);
  }
  const sends = new Map(
    db
      .prepare(`SELECT contact_id, COUNT(*) AS n, MAX(sent_at) AS last FROM mail_sends WHERE contact_id IN (${marks}) AND status = 'sent' GROUP BY contact_id`)
      .all(...ids)
      .map((r) => [r.contact_id, r])
  );
  return rows.map((r) => ({
    email: r.email,
    status: r.status,
    statusAt: r.status_at || null,
    createdAt: r.created_at,
    lists: lists.get(r.id),
    site: sites.get(r.id) || null,
    lastSentAt: sends.get(r.id)?.last || null,
    sentCount: sends.get(r.id)?.n || 0,
  }));
}

export function contacts(project, { q = '', status = '', source = '', list = '', page = 1, perPage = 50 } = {}) {
  const where = ['c.project_id = ?'];
  const args = [project.id];
  const query = String(q || '').trim().toLowerCase();
  if (query) {
    where.push("c.email LIKE ? ESCAPE '\\'");
    args.push(`%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  if (status && CONTACT_STATUS[status]) {
    where.push('c.status = ?');
    args.push(status);
  }
  const listId = Number(list) || 0;
  const src = MEMBER_SOURCES.includes(source) ? source : '';
  if (listId || src) {
    const cond = ['m.contact_id = c.id', 'm.removed_at IS NULL'];
    if (listId) {
      cond.push('m.list_id = ?');
      args.push(listId);
    }
    if (src) {
      cond.push(`${sourceSql(specialLists())} = ?`);
      args.push(src);
    }
    where.push(`EXISTS (SELECT 1 FROM mail_list_members m WHERE ${cond.join(' AND ')})`);
  }
  const size = Math.min(PER_PAGE_MAX, Math.max(1, Number(perPage) || 50));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM mail_contacts c WHERE ${where.join(' AND ')}`).get(...args).n;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const rows = db
    .prepare(`SELECT c.* FROM mail_contacts c WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`)
    .all(...args, size, (current - 1) * size);
  return { total, page: current, pages, contacts: decorate(rows) };
}

export function statuses(project, emails) {
  const wanted = [...new Set((Array.isArray(emails) ? emails : []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const out = {};
  if (!wanted.length) return { statuses: out };
  const marks = wanted.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM mail_contacts WHERE project_id = ? AND email IN (${marks})`).all(project.id, ...wanted);
  const byEmail = new Map(decorate(rows).map((c) => [c.email, c]));
  for (const email of wanted) {
    const c = byEmail.get(email);
    out[email] = c ? { status: c.status, statusAt: c.statusAt, lists: c.lists.map((l) => l.name), lastSentAt: c.lastSentAt } : null;
  }
  return { statuses: out };
}

/* --------------------------------- маршруты -------------------------------- */

/**
 * @param {import('express').Express} app
 * @param {{requireAccess: (area: string) => Function}} deps
 */
export function mountCrmAccess(app, { requireAccess }) {
  const api = express.Router();

  // Перебор ключа считается как у входа; удачный запрос счётчик сбрасывает.
  api.use((req, res, next) => {
    const bucket = `crm-access:${req.ip}`;
    if (tooManyAttempts(bucket, { limit: 20 })) return res.status(429).json({ error: 'Слишком много попыток с неверным ключом' });
    const auth = authenticate(req.headers['x-integration-key'], { ip: req.ip });
    if (auth.status === 401) return res.status(401).json({ error: 'Ключ не узнан' });
    if (auth.status === 403) return res.status(403).json({ error: 'Ключ отозван' });
    clearAttempts(bucket);
    next();
  });

  const withProject = (fn) => (req, res) => {
    const slug = String(req.query.project || req.body?.project || '');
    const project = slug ? getProjectBySlug(slug) : null;
    if (!project) return res.status(400).json({ error: 'Неизвестный project' });
    try {
      res.json(fn(project, req));
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      log('error', `доступ админки школы: сбой на ${req.method} ${req.path}: ${err.message}`);
      res.status(500).json({ error: 'Сбой панели' });
    }
  };

  api.get('/projects', (_req, res) => res.json(projectsPayload()));
  api.get('/summary', withProject((project) => summary(project)));
  api.get('/contacts', withProject((project, req) => contacts(project, req.query)));
  api.post(
    '/contacts/status',
    withProject((project, req) => {
      const emails = req.body?.emails;
      if (!Array.isArray(emails) || emails.length > STATUS_BATCH) {
        const err = new Error(`emails — список до ${STATUS_BATCH} адресов`);
        err.status = 400;
        throw err;
      }
      return statuses(project, emails);
    })
  );
  app.use('/api/integration/crm', api);

  /* ---- управление ключами: только владелец ---- */
  const owner = [requireAccess('platforms'), (req, res, next) => (req.user?.role === 'owner' ? next() : res.status(403).json({ error: 'Только владелец' }))];
  app.get('/api/settings/crm-access', ...owner, (_req, res) => res.json({ keys: listKeys() }));
  app.post('/api/settings/crm-access', ...owner, (req, res) => res.json(issueKey(req.body?.name, req.user.id)));
  app.post('/api/settings/crm-access/:id/revoke', ...owner, (req, res) => {
    const item = revokeKey(req.params.id);
    if (!item) return res.status(404).json({ error: 'Ключ не найден' });
    res.json({ item });
  });
}
