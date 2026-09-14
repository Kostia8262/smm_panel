/**
 * Лента согласий CRM школы → базы «CRM школы».
 *
 *   — без ключа ленты воркер ничего не спрашивает;
 *   — с согласием адрес ложится в базу своей школы по сайту заявки, повтор не
 *     плодит событий, курсор двигается по пачкам, пока hasMore;
 *   — согласие снято → адрес уходит из базы, но не в стоп-лист;
 *   — отписавшегося лента не возвращает;
 *   — заявка стала клиентом → из базы заявок в базу клиентов;
 *   — ошибка админки не двигает курсор и запоминается для настроек.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-crmfeed-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');
process.env.MAIL_MEDIA_DIR = join(dir, 'mail-media');
process.env.UPLOAD_DIR = join(dir, 'uploads');

const { db } = await import('../src/db.js');
const { getSetting, setSetting } = await import('../src/staff.js');
const { encrypt } = await import('../src/secrets.js');
const store = await import('../src/mail/store.js');
const feed = await import('../src/mail/crm-feed.js');

const ACCESS = { apiUrl: 'https://crm.example', apiKey: 'mcai_test' };
const consent = (source = 'thank_you') => ({ at: '2026-09-14T10:00:00Z', version: source === 'manager' ? 'manager-2026-09' : 'thankyou-2026-09-uk', source });
const person = (over = {}) => ({ kind: 'lead', id: 7, name: 'Олена', status: 'new', course: 'python', site: 'python.mycomputer.education', lang: 'uk', ...over });

/** Админка-заглушка: отдаёт заранее заданные пачки по after. */
function crm(pages) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), key: init.headers['x-integration-key'] });
    const after = new URL(url).searchParams.get('after');
    const page = pages[after];
    if (page instanceof Error) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => page || { items: [], next: Number(after), hasMore: false } };
  };
  fn.calls = calls;
  return fn;
}

const projectId = (slug) => db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug).id;
const members = (listName, slug = 'education') =>
  db
    .prepare(
      `SELECT c.email, m.attrs, m.removed_at FROM mail_list_members m JOIN mail_contacts c ON c.id = m.contact_id
        JOIN mail_lists l ON l.id = m.list_id WHERE l.name = ? AND l.project_id = ? ORDER BY c.email`
    )
    .all(listName, projectId(slug));
const active = (listName, slug) => members(listName, slug).filter((m) => !m.removed_at).map((m) => m.email);

before(() => {
  setSetting('crm_feed_cursor', '');
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Временный каталог подчистит система.
  }
});

test('без ключа ленты — ни одного запроса', async () => {
  const fetchImpl = crm({});
  assert.equal(await feed.pullFeed({ access: { apiUrl: ACCESS.apiUrl, apiKey: '' }, fetchImpl }), null);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(feed.feedState().hasToken, false);
  setSetting('crm_feed_token', encrypt('mcai_saved'));
  assert.equal(feed.feedAccess().apiKey, 'mcai_saved');
  assert.equal(feed.feedState().hasToken, true);
});

test('школа по сайту заявки: child раньше .education, пустой — академия, чужой — никуда', () => {
  assert.equal(feed.projectSlugOfSite('https://child.mycomputer.education/uk/'), 'child');
  assert.equal(feed.projectSlugOfSite('roblox.mycomputer.education'), 'education');
  assert.equal(feed.projectSlugOfSite('mycomputer.school'), 'school');
  assert.equal(feed.projectSlugOfSite('blender.mycomputer.school'), 'school');
  assert.equal(feed.projectSlugOfSite('fluent-fox.site'), 'fluentfox');
  assert.equal(feed.projectSlugOfSite(null), 'education');
  assert.equal(feed.projectSlugOfSite('evil.example'), null);
});

test('согласие → база своей школы, пачки до hasMore, повтор не плодит событий', async () => {
  const fetchImpl = crm({
    0: {
      items: [
        { seq: 1, email: 'olena@example.com', consent: consent(), person: person() },
        { seq: 2, email: 'dizain@example.com', consent: consent(), person: person({ site: 'blender.mycomputer.school', course: 'blender' }) },
      ],
      next: 2,
      hasMore: true,
    },
    2: {
      items: [
        { seq: 3, email: 'bad address', consent: consent(), person: person() },
        { seq: 4, email: 'foreign@example.com', consent: consent(), person: person({ site: 'evil.example' }) },
        { seq: 5, email: 'nocons@example.com', consent: null, person: person() },
        { seq: 6, email: 'client@example.com', consent: consent('manager'), person: person({ kind: 'client', site: null, status: 'active', lang: null }) },
      ],
      next: 6,
      hasMore: false,
    },
  });
  const out = await feed.pullFeed({ access: ACCESS, fetchImpl });
  assert.equal(out.pages, 2);
  assert.deepEqual(out.stats, { added: 3, invalid: 1, unknown_site: 1, absent: 1 });
  assert.equal(getSetting('crm_feed_cursor', ''), '6');
  assert.ok(fetchImpl.calls.every((c) => c.key === ACCESS.apiKey));
  assert.match(fetchImpl.calls[0].url, /\/api\/integration\/mail\/feed\?after=0&limit=500$/);

  assert.deepEqual(active('CRM школы — заявки'), ['olena@example.com']);
  assert.deepEqual(active('CRM школы — заявки', 'school'), ['dizain@example.com']);
  assert.deepEqual(active('CRM школы — клиенты'), ['client@example.com']);
  const attrs = JSON.parse(members('CRM школы — заявки')[0].attrs);
  assert.deepEqual(attrs, { 'CRM id': '7', Кто: 'заявка', Статус: 'new', Курс: 'python', Сайт: 'python.mycomputer.education', Язык: 'uk' });
  const list = store.listLists(projectId('education')).find((l) => l.name === 'CRM школы — заявки');
  assert.equal(list.consentBasis, 'lead');

  // Полная пересверка с нуля: те же адреса — ни новых событий, ни дублей.
  const events = () => db.prepare("SELECT COUNT(*) AS n FROM mail_events WHERE source = 'crm'").get().n;
  assert.equal(events(), 3);
  setSetting('crm_feed_cursor', '0');
  const again = await feed.pullFeed({ access: ACCESS, fetchImpl });
  assert.equal(again.stats.added, undefined);
  assert.equal(again.stats.updated, 3);
  assert.equal(events(), 3);
});

test('согласие снято → из базы, но не в стоп-лист; вернулось → снова в базе', async () => {
  const pid = projectId('education');
  await feed.pullFeed({ access: ACCESS, fetchImpl: crm({ 6: { items: [{ seq: 7, email: 'olena@example.com', consent: null, person: null }], next: 7, hasMore: false } }) });
  assert.deepEqual(active('CRM школы — заявки'), []);
  assert.equal(store.isSuppressed(pid, 'olena@example.com'), false, 'снятая галочка — не отписка');
  await feed.pullFeed({ access: ACCESS, fetchImpl: crm({ 7: { items: [{ seq: 8, email: 'olena@example.com', consent: consent(), person: person() }], next: 8, hasMore: false } }) });
  assert.deepEqual(active('CRM школы — заявки'), ['olena@example.com']);
});

test('заявка стала клиентом — переезжает в базу клиентов; отписавшегося лента не возвращает', async () => {
  const pid = projectId('education');
  await feed.pullFeed({
    access: ACCESS,
    fetchImpl: crm({ 8: { items: [{ seq: 9, email: 'olena@example.com', consent: consent('manager'), person: person({ kind: 'client', status: 'active' }) }], next: 9, hasMore: false } }),
  });
  assert.deepEqual(active('CRM школы — заявки'), []);
  assert.deepEqual(active('CRM школы — клиенты'), ['client@example.com', 'olena@example.com']);

  const contact = db.prepare('SELECT id FROM mail_contacts WHERE project_id = ? AND email = ?').get(pid, 'client@example.com');
  store.selfUnsubscribe(contact.id, pid, { source: 'page' });
  const out = await feed.pullFeed({
    access: ACCESS,
    fetchImpl: crm({ 9: { items: [{ seq: 10, email: 'client@example.com', consent: consent('manager'), person: person({ kind: 'client', site: null }) }], next: 10, hasMore: false } }),
  });
  assert.deepEqual(out.stats, { refused: 1 });
  assert.equal(store.isSuppressed(pid, 'client@example.com'), true);
});

test('ошибка админки не двигает курсор и видна в настройках', async () => {
  await assert.rejects(feed.pullFeed({ access: ACCESS, fetchImpl: crm({ 10: new Error('boom') }) }), /ответила 500/);
  assert.equal(getSetting('crm_feed_cursor', ''), '10');
  assert.match(feed.feedState().lastError, /500/);
  await feed.pullFeed({ access: ACCESS, fetchImpl: crm({}) });
  assert.equal(feed.feedState().lastError, null);
});
