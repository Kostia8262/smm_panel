/**
 * Сегменты CRM школы → базы «CRM: …».
 *
 *   — без ключа ленты — ни одного запроса; заход не чаще раза в 15 минут;
 *   — база на сегмент и школу, имя = title, основание по basis;
 *   — выпал из сегмента → removed_at, но не в стоп-лист;
 *   — отписавшегося сегмент не возвращает;
 *   — сегмент выключен → база в архив без удаления, включён — та же база;
 *   — базу сегмента руками не правят; скопировать из неё можно;
 *   — чужой ключ останавливает заход, сбой одной школы — нет.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-crmseg-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');
process.env.MAIL_MEDIA_DIR = join(dir, 'mail-media');
process.env.UPLOAD_DIR = join(dir, 'uploads');

const { db } = await import('../src/db.js');
const { getSetting } = await import('../src/staff.js');
const store = await import('../src/mail/store.js');
const seg = await import('../src/mail/crm-segments.js');

const ACCESS = { apiUrl: 'https://crm.example', apiKey: 'mcai_test' };
const T0 = Date.parse('2026-09-14T12:00:00Z');

/**
 * Админка-заглушка. `schools[slug]` — { segments: {key: {title, members}} } | Error | 401.
 */
function crm(schools) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), key: init.headers['x-integration-key'] });
    const u = new URL(url);
    const school = schools[u.searchParams.get('project')] ?? { segments: {} };
    if (school === 401) return { ok: false, status: 401, json: async () => ({}) };
    if (school instanceof Error) return { ok: false, status: 500, json: async () => ({}) };
    const m = /\/segments\/([^/]+)\/members$/.exec(u.pathname);
    if (!m) {
      const segments = Object.entries(school.segments).map(([key, s]) => ({ key, title: s.title, description: '', count: s.members.length, computedAt: '2026-09-14T11:55:00Z' }));
      return { ok: true, status: 200, json: async () => ({ success: true, segments }) };
    }
    const s = school.segments[m[1]];
    if (!s || s.gone) return { ok: false, status: 404, json: async () => ({ success: false }) };
    return { ok: true, status: 200, json: async () => ({ success: true, key: m[1], title: s.title, computedAt: '2026-09-14T11:55:00Z', count: s.members.length, members: s.members }) };
  };
  fn.calls = calls;
  return fn;
}

const pid = (slug) => db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug).id;
const listOf = (slug, key) => db.prepare('SELECT * FROM mail_lists WHERE project_id = ? AND crm_segment = ?').get(pid(slug), key);
const activeIn = (listId) =>
  db
    .prepare(
      `SELECT c.email FROM mail_list_members m JOIN mail_contacts c ON c.id = m.contact_id
        WHERE m.list_id = ? AND m.removed_at IS NULL ORDER BY c.email`
    )
    .all(listId)
    .map((r) => r.email);

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Временный каталог подчистит система.
  }
});

const ACTIVE = { title: 'CRM: Батьки активних учнів', members: [{ email: 'mama@example.com', basis: 'client' }, { email: 'tato@example.com', basis: 'client' }] };
const TRIAL = { title: 'CRM: Пробне заняття без запису', members: [{ email: 'lead@example.com', basis: 'lead' }, { email: 'mama@example.com', basis: 'client' }] };

test('без ключа ленты — ни одного запроса', async () => {
  const fetchImpl = crm({});
  assert.equal(await seg.pullSegments({ access: { ...ACCESS, apiKey: '' }, fetchImpl }), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('сегменты → базы своей школы: имя, основание, повтор не плодит событий', async () => {
  const fetchImpl = crm({ education: { segments: { active: ACTIVE, trial: TRIAL } }, school: { segments: { active: { title: ACTIVE.title, members: [{ email: 'dizain@example.com', basis: 'client' }] } } } });
  const out = await seg.pullSegments({ access: ACCESS, fetchImpl, now: T0 });
  assert.equal(out.schools.education.segments, 2);
  assert.equal(out.schools.education.added, 4);
  assert.ok(fetchImpl.calls.every((c) => c.key === ACCESS.apiKey));
  assert.ok(fetchImpl.calls.some((c) => c.url === 'https://crm.example/api/integration/mail/segments?project=child'), 'все четыре школы');
  assert.ok(fetchImpl.calls.some((c) => c.url === 'https://crm.example/api/integration/mail/segments/trial/members?project=education'));

  const active = listOf('education', 'active');
  assert.equal(active.name, 'CRM: Батьки активних учнів');
  assert.equal(active.consent_basis, 'client');
  assert.deepEqual(activeIn(active.id), ['mama@example.com', 'tato@example.com']);
  const trial = listOf('education', 'trial');
  assert.equal(trial.consent_basis, 'lead', 'хоть одна заявка — основание базы «заявка»');
  assert.deepEqual(activeIn(trial.id), ['lead@example.com', 'mama@example.com']);
  assert.deepEqual(activeIn(listOf('school', 'active').id), ['dizain@example.com']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_contacts WHERE email = 'mama@example.com'").get().n, 1, 'один адрес — один контакт в школе');

  const card = store.getContact(db.prepare('SELECT id FROM mail_contacts WHERE email = ?').get('lead@example.com').id);
  assert.equal(card.memberships[0].source, 'сегмент CRM школы');
  assert.deepEqual(card.memberships[0].attrs, { Основание: 'заявка' });
  assert.equal(getSetting('crm_segments_last_error', ''), '');
  assert.ok(getSetting('crm_segments_last_at', ''));

  const events = () => db.prepare("SELECT COUNT(*) AS n FROM mail_events WHERE source = 'crm_segment'").get().n;
  assert.equal(events(), 5);
  const again = await seg.pullSegments({ access: ACCESS, fetchImpl, now: T0 + 1000 });
  assert.equal(again.schools.education.added, 0);
  assert.equal(events(), 5);
});

test('заход не чаще раза в 15 минут', () => {
  assert.equal(seg.segmentsDue(T0 + 1000 + 60 * 1000), false);
  assert.equal(seg.segmentsDue(T0 + 1000 + 15 * 60 * 1000), true);
});

test('выпал из сегмента → убран, но не в стоп-лист; отписавшегося не возвращает', async () => {
  const education = pid('education');
  const mama = db.prepare('SELECT id FROM mail_contacts WHERE project_id = ? AND email = ?').get(education, 'mama@example.com');
  store.selfUnsubscribe(mama.id, education, { source: 'page' });

  const fetchImpl = crm({
    education: {
      segments: {
        active: { title: ACTIVE.title, members: [{ email: 'mama@example.com', basis: 'client' }, { email: 'new@example.com', basis: 'client' }] },
        trial: TRIAL,
      },
    },
  });
  const out = await seg.pullSegments({ access: ACCESS, fetchImpl, now: T0 + 20 * 60 * 1000 });
  const active = listOf('education', 'active');
  assert.deepEqual(activeIn(active.id), ['mama@example.com', 'new@example.com'], 'отписавшаяся остаётся в составе, но письма ей не уйдут');
  assert.equal(out.schools.education.removed, 1);
  assert.equal(store.isSuppressed(education, 'tato@example.com'), false, 'выпал из сегмента — не отписка');
  assert.equal(store.getContact(mama.id).status, 'unsubscribed');

  // Отписавшийся, которого в базе ещё не было, туда не попадает.
  const gone = db.prepare('SELECT id FROM mail_contacts WHERE project_id = ? AND email = ?').get(education, 'tato@example.com');
  store.selfUnsubscribe(gone.id, education, { source: 'page' });
  const back = await seg.pullSegments({ access: ACCESS, fetchImpl: crm({ education: { segments: { active: ACTIVE, trial: TRIAL } } }), now: T0 + 40 * 60 * 1000 });
  assert.equal(back.schools.education.refused, 3, 'mama отказалась в двух сегментах, tato — в одном');
  assert.deepEqual(activeIn(active.id), ['mama@example.com']);
});

test('сегмент выключен → база в архив без удаления; включён — та же база', async () => {
  const trial = listOf('education', 'trial');
  const out = await seg.pullSegments({ access: ACCESS, fetchImpl: crm({ education: { segments: { active: ACTIVE } } }), now: T0 + 60 * 60 * 1000 });
  assert.equal(out.schools.education.archived, 1);
  const archived = listOf('education', 'trial');
  assert.ok(archived.archived_at);
  assert.deepEqual(activeIn(trial.id), ['lead@example.com', 'mama@example.com'], 'состав не тронут');

  // 404 на составе между двумя запросами — тоже «выключен».
  await seg.pullSegments({ access: ACCESS, fetchImpl: crm({ education: { segments: { active: { ...ACTIVE, gone: true } } } }), now: T0 + 80 * 60 * 1000 });
  assert.ok(listOf('education', 'active').archived_at);

  await seg.pullSegments({ access: ACCESS, fetchImpl: crm({ education: { segments: { active: ACTIVE, trial: TRIAL } } }), now: T0 + 100 * 60 * 1000 });
  const restored = listOf('education', 'trial');
  assert.equal(restored.id, trial.id);
  assert.equal(restored.archived_at, null);
  assert.equal(listOf('education', 'active').archived_at, null);
});

test('базу сегмента руками не правят; скопировать из неё в свою можно', () => {
  const education = pid('education');
  const active = store.getList(listOf('education', 'active').id);
  assert.equal(active.crmSegment, 'active');
  const own = store.createList(education, { name: 'Свои родители', consentBasis: 'client' });
  const mama = db.prepare('SELECT id FROM mail_contacts WHERE project_id = ? AND email = ?').get(education, 'new@example.com');

  assert.throws(() => store.addContactManually({ listId: active.id, email: 'hand@example.com' }), /приходит из CRM/);
  assert.throws(() => store.updateList(active.id, { name: 'Другое имя' }), /приходит из CRM/);
  assert.throws(() => store.updateList(active.id, { archived: true }), /приходит из CRM/);
  assert.throws(() => store.updateMemberAttrs(active.id, mama.id, { Основание: 'x' }), /приходит из CRM/);
  assert.throws(() => store.bulk({ projectId: education, ids: [mama.id], action: 'remove', listId: active.id }), /приходит из CRM/);
  assert.throws(() => store.bulk({ projectId: education, ids: [mama.id], action: 'move', listId: active.id, targetListId: own.id }), /приходит из CRM/);
  assert.throws(() => store.bulk({ projectId: education, ids: [mama.id], action: 'copy', targetListId: active.id }), /приходит из CRM/);

  assert.deepEqual(store.bulk({ projectId: education, ids: [mama.id], action: 'copy', listId: active.id, targetListId: own.id }), { done: 1 });
});

test('имя занято обычной базой школы — база сегмента получает пометку', async () => {
  store.createList(pid('child'), { name: 'CRM: Учні на паузі', consentBasis: 'client' });
  await seg.pullSegments({
    access: ACCESS,
    fetchImpl: crm({ child: { segments: { paused: { title: 'CRM: Учні на паузі', members: [] } } } }),
    now: T0 + 120 * 60 * 1000,
  });
  const paused = listOf('child', 'paused');
  assert.equal(paused.name, 'CRM: Учні на паузі · paused');
  assert.equal(paused.consent_basis, 'lead', 'пустой сегмент — осторожное основание');
});

test('чужой ключ останавливает заход; сбой одной школы не мешает остальным', async () => {
  const bad = crm({ education: 401 });
  await assert.rejects(seg.pullSegments({ access: ACCESS, fetchImpl: bad, now: T0 + 140 * 60 * 1000 }), /не узнала ключ/);
  assert.equal(bad.calls.length, 1);
  assert.match(seg.segmentsState().lastError, /ключ/);

  await seg.pullSegments({ access: ACCESS, fetchImpl: crm({ education: { segments: { active: ACTIVE } } }), now: T0 + 150 * 60 * 1000 });
  assert.equal(listOf('education', 'active').archived_at, null);
  const partial = crm({ education: new Error('boom'), school: { segments: { active: { title: ACTIVE.title, members: [{ email: 'second@example.com', basis: 'client' }] } } } });
  await assert.rejects(seg.pullSegments({ access: ACCESS, fetchImpl: partial, now: T0 + 160 * 60 * 1000 }), /education: Админка школы ответила 500/);
  assert.deepEqual(activeIn(listOf('school', 'active').id), ['second@example.com']);
  assert.equal(listOf('education', 'active').archived_at, null, 'сбой списка не архивирует базы школы');
  assert.match(seg.segmentsState().lastError, /education/);
});
