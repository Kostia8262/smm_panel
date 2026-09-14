/**
 * Доступ админки школы к панели: ключи и ответы только на чтение.
 *
 *   — без ключа и с чужим ключом 401, с отозванным 403, в базе нет открытого ключа;
 *   — сводка считает состояния, базы, происхождение и подписки по сайтам;
 *   — список контактов фильтрует по адресу, состоянию, происхождению и базе,
 *     отдаёт сайт и письма рассылок, но не имена;
 *   — статусы пачкой: неизвестный адрес — null, больше 200 — 400;
 *   — ключи выпускает и отзывает только владелец.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-crmaccess-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');
process.env.MAIL_MEDIA_DIR = join(dir, 'mail-media');
process.env.UPLOAD_DIR = join(dir, 'uploads');

const express = (await import('express')).default;
const { db } = await import('../src/db.js');
const staff = await import('../src/staff.js');
const { setSetting } = staff;
const store = await import('../src/mail/store.js');
const feed = await import('../src/mail/crm-feed.js');
const access = await import('../src/mail/crm-access.js');
const { resetAll } = await import('../src/ratelimit.js');

let server;
let base;
let role = 'owner';
let pid;
let ownerId;

async function call(path, { key, method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(key ? { 'x-integration-key': key } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  pid = db.prepare("SELECT id FROM projects WHERE slug = 'education'").get().id;
  ownerId = staff.create({ name: 'Владелец', role: 'owner' }).id;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: ownerId, role };
    next();
  });
  const requireAccess = () => (_req, _res, next) => next();
  access.mountCrmAccess(app, { requireAccess });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // Форма сайта: база «Подписка с сайта» и запись подписки.
  const form = store.createList(pid, { name: 'Подписка с сайта', consentBasis: 'form' });
  setSetting(`mail_signup_list_${pid}`, String(form.id));
  const ivan = store.upsertContact(pid, 'ivan@example.com', 'Іван').id;
  store.addMembership(form.id, ivan);
  db.prepare(
    "INSERT INTO mail_signups (project_id, email, token_hash, status, site, contact_id, created_at) VALUES (?, 'ivan@example.com', 't1', 'subscribed', 'python.mycomputer.education', ?, ?)"
  ).run(pid, ivan, new Date().toISOString());

  // Лента CRM.
  db.exec('BEGIN');
  feed.applyItem({
    seq: 1,
    email: 'olena@example.com',
    consent: { at: '2026-09-14T10:00:00Z', version: 'thankyou-2026-09-uk', source: 'thank_you' },
    person: { kind: 'lead', id: 7, childName: 'Оля', status: 'new', course: 'python', site: 'roblox.mycomputer.education', lang: 'uk' },
  });
  db.exec('COMMIT');

  // Загрузка файлом и отписавшийся.
  const imported = store.createList(pid, { name: 'Выпускники', consentBasis: 'client' });
  const importId = Number(
    db.prepare("INSERT INTO mail_imports (project_id, list_id, source_name, format, status) VALUES (?, ?, 'a.csv', 'csv', 'done')").run(pid, imported.id).lastInsertRowid
  );
  const petro = store.upsertContact(pid, 'petro@example.com', 'Петро').id;
  store.addMembership(imported.id, petro, { importId });
  store.selfUnsubscribe(petro, pid, { source: 'page' });

  // Письмо рассылки Ивану.
  const sender = Number(db.prepare("INSERT INTO mail_senders (email, kind) VALUES ('box@gmail.com', 'gmail')").run().lastInsertRowid);
  const campaign = Number(db.prepare("INSERT INTO mail_campaigns (project_id, title) VALUES (?, 'Осінь')").run(pid).lastInsertRowid);
  db.prepare("INSERT INTO mail_sends (campaign_id, sender_id, contact_id, email, status, sent_at) VALUES (?, ?, ?, 'ivan@example.com', 'sent', '2026-09-14T11:00:00Z')").run(campaign, sender, ivan);
});

after(() => {
  server?.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Временный каталог подчистит система.
  }
});

test('ключ: без него и чужой — 401, выпущенный работает, в базе только хеш, отозванный — 403', async () => {
  resetAll();
  assert.equal((await call('/api/integration/crm/projects')).status, 401);
  assert.equal((await call('/api/integration/crm/projects', { key: 'smmk_wrong' })).status, 401);

  const issued = await call('/api/settings/crm-access', { method: 'POST', body: { name: 'Админка школы' } });
  assert.equal(issued.status, 200);
  const key = issued.body.key;
  assert.match(key, /^smmk_/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_access_keys WHERE key_hash = ?').get(key).n, 0, 'открытого ключа в базе нет');

  const projects = await call('/api/integration/crm/projects', { key });
  assert.equal(projects.status, 200);
  assert.ok(projects.body.projects.some((p) => p.slug === 'education' && p.title));
  assert.ok(access.listKeys()[0].lastUsedAt, 'видно последнее использование');

  await call(`/api/settings/crm-access/${issued.body.item.id}/revoke`, { method: 'POST' });
  assert.equal((await call('/api/integration/crm/projects', { key })).status, 403);
});

test('ключи выпускает только владелец', async () => {
  role = 'smm';
  assert.equal((await call('/api/settings/crm-access', { method: 'POST', body: {} })).status, 403);
  assert.equal((await call('/api/settings/crm-access')).status, 403);
  role = 'owner';
});

test('сводка, список контактов и статусы', async () => {
  resetAll();
  const { key } = access.issueKey('Админка');
  assert.equal((await call('/api/integration/crm/summary?project=nope', { key })).status, 400);

  const s = (await call('/api/integration/crm/summary?project=education', { key })).body;
  assert.equal(s.project, 'education');
  assert.deepEqual(
    { contacts: s.totals.contacts, active: s.totals.active, unsubscribed: s.totals.unsubscribed },
    { contacts: 3, active: 2, unsubscribed: 1 }
  );
  assert.deepEqual(s.sources.form, { active: 1, total: 1 });
  assert.deepEqual(s.sources.crm_feed, { active: 1, total: 1 });
  assert.deepEqual(s.sources.import, { active: 0, total: 1 });
  assert.deepEqual(s.signupsBySite, [{ site: 'python.mycomputer.education', total: 1, last30: 1 }]);
  assert.ok(s.lists.find((l) => l.name === 'CRM школы — заявки' && l.consentBasis === 'lead' && l.total === 1));

  const all = (await call('/api/integration/crm/contacts?project=education', { key })).body;
  assert.equal(all.total, 3);
  assert.equal(all.pages, 1);
  const ivan = all.contacts.find((c) => c.email === 'ivan@example.com');
  assert.equal(ivan.site, 'python.mycomputer.education');
  assert.equal(ivan.sentCount, 1);
  assert.equal(ivan.lastSentAt, '2026-09-14T11:00:00Z');
  assert.equal(ivan.lists[0].source, 'form');
  assert.equal('name' in ivan, false, 'имён админка не получает');
  const olena = all.contacts.find((c) => c.email === 'olena@example.com');
  assert.equal(olena.site, 'roblox.mycomputer.education');
  assert.equal(olena.lists[0].source, 'crm_feed');
  assert.equal(JSON.stringify(all).includes('Оля'), false, 'колонки баз наружу не уходят');

  const q = async (qs) => (await call(`/api/integration/crm/contacts?project=education&${qs}`, { key })).body;
  assert.deepEqual((await q('q=OLENA')).contacts.map((c) => c.email), ['olena@example.com']);
  assert.deepEqual((await q('status=unsubscribed')).contacts.map((c) => c.email), ['petro@example.com']);
  assert.deepEqual((await q('source=import')).contacts.map((c) => c.email), ['petro@example.com']);
  assert.equal((await q('q=%25')).total, 0, 'знак % в поиске — буква, а не шаблон');
  const paged = await q('perPage=1&page=2');
  assert.equal(paged.pages, 3);
  assert.equal(paged.contacts.length, 1);

  const st = await call('/api/integration/crm/contacts/status', { key, method: 'POST', body: { project: 'education', emails: ['IVAN@example.com', 'nobody@example.com'] } });
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.statuses['nobody@example.com'], null);
  assert.equal(st.body.statuses['ivan@example.com'].status, 'active');
  assert.deepEqual(st.body.statuses['ivan@example.com'].lists, ['Подписка с сайта']);
  const tooMany = Array.from({ length: 201 }, (_, i) => `a${i}@example.com`);
  assert.equal((await call('/api/integration/crm/contacts/status', { key, method: 'POST', body: { project: 'education', emails: tooMany } })).status, 400);
});
