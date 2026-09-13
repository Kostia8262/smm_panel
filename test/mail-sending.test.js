/**
 * Рассылка, фаза 4: отправка.
 *
 * Обещания, которые проверяем:
 *   — человек в двух базах получает одно письмо, отписавшийся — ни одного,
 *     даже если отписался посреди рассылки;
 *   — письмо без ответа Google не повторяется;
 *   — окно, потолок суток и пауза Google держат отправку;
 *   — отмена останавливает очередь, картинки снимаются только без живых копий.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

const dir = mkdtempSync(join(tmpdir(), 'smm-mail4-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');
process.env.MAIL_MEDIA_DIR = join(dir, 'mail-media');
process.env.UPLOAD_DIR = join(dir, 'uploads');
process.env.PUBLIC_BASE_URL = 'https://smm.example';

const { db } = await import('../src/db.js');
const staff = await import('../src/staff.js');
const store = await import('../src/mail/store.js');
const senders = await import('../src/mail/sender/senders.js');
const campaigns = await import('../src/mail/campaigns.js');
const runner = await import('../src/mail/runner.js');
const throttle = await import('../src/mail/sender/throttle.js');
const mailMedia = await import('../src/mail/compose/media.js');

// 14.09.2026 12:00 по Киеву (UTC+3) — окно 08:00–21:00 открыто.
const NOON = Date.parse('2026-09-14T09:00:00Z');

let projectId;
let owner;
let smm;
let senderId;
let pupils;
let parents;
const contacts = {};

function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}

/** Google понарошку: `plan(to)` решает, что ответить на письмо этому адресу. */
function fakeGoogle(plan = () => 'ok') {
  const sent = [];
  const fn = async (url, init = {}) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'A', expires_in: 3600 }) };
    const raw = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8');
    const to = /^To: .*?<?([^<>\s]+@[^<>\s]+)>?$/m.exec(raw)?.[1];
    const answer = plan(to);
    if (answer === 'hang') throw new Error('socket hang up');
    if (answer === 'bad-address') return { ok: false, status: 400, json: async () => ({ error: { message: 'Invalid To header' } }) };
    if (answer === 'rate') return { ok: false, status: 429, json: async () => ({ error: { message: 'User-rate limit exceeded. Retry after 2026-09-14T09:30:00.000Z', errors: [{ reason: 'userRateLimitExceeded' }] } }) };
    sent.push({ to, raw });
    return { ok: true, status: 200, json: async () => ({ id: `g${sent.length}` }) };
  };
  fn.sent = sent;
  return fn;
}

function approvedCampaign({ title = 'Набір', include = [pupils.id, parents.id], exclude = [], blocks = null, withImage = false } = {}) {
  const c = campaigns.createCampaign(projectId, { staffId: owner.id });
  let mediaId = null;
  if (withImage) mediaId = mailMedia.saveImage(c.id, { buffer: png(1200, 600), originalName: 'hero.png' }).id;
  const updated = campaigns.updateCampaign(c.id, {
    title,
    subject: 'Новий набір',
    preheader: 'Перше заняття безкоштовне',
    blocks: blocks || [
      ...(withImage ? [{ type: 'hero', mediaId, alt: 'Діти' }] : []),
      { type: 'heading', text: 'Привіт' },
      { type: 'text', text: '{{name|Друже}}, доброго дня! [Розклад](https://mycomputer.education/schedule)' },
      { type: 'button', text: 'Записатися', href: 'https://mycomputer.education/trial' },
    ],
    lists: { include, exclude },
  });
  db.prepare("INSERT INTO mail_test_sends (sender_id, campaign_id, content_hash, to_email, gmail_id, sent_at) VALUES (?, ?, ?, 'me@example.com', 'gt', ?)").run(
    senderId,
    updated.id,
    updated.contentHash,
    new Date(NOON - 3600000).toISOString()
  );
  return campaigns.approveCampaign(updated.id, owner);
}

/** Шаги отправщика подряд, без пауз между письмами. */
async function drain(fetchImpl, { now = NOON, steps = 20 } = {}) {
  const outcomes = [];
  for (let i = 0; i < steps; i++) {
    runner.resetPacing();
    const out = await runner.mailStep({ now: now + i * 1000, fetchImpl });
    outcomes.push(...Object.values(out.results || {}));
  }
  return outcomes;
}

before(() => {
  projectId = db.prepare("SELECT id FROM projects WHERE slug = 'education'").get().id;
  owner = staff.create({ name: 'Власник', role: 'owner' });
  smm = staff.create({ name: 'Катя', role: 'smm' });
  senders.saveGoogleApp({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'secret' });
  senderId = senders.saveConnected({ email: 'box@gmail.com', refreshToken: 'r' }, NOON - 30 * 86400000).id;

  pupils = store.createList(projectId, { name: 'Учні', consentBasis: 'client' });
  parents = store.createList(projectId, { name: 'Батьки', consentBasis: 'event' });
  contacts.both = store.addContactManually({ listId: pupils.id, email: 'both@example.com', name: 'Ірина' }).contactId;
  store.bulk({ projectId, ids: [contacts.both], action: 'copy', targetListId: parents.id });
  contacts.a = store.addContactManually({ listId: pupils.id, email: 'a@example.com' }).contactId;
  contacts.b = store.addContactManually({ listId: parents.id, email: 'b@example.com', name: 'Олег' }).contactId;
  contacts.gone = store.addContactManually({ listId: parents.id, email: 'gone@example.com' }).contactId;
  store.bulk({ projectId, ids: [contacts.gone], action: 'unsubscribe' });
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Временный каталог подчистит система.
  }
});

/* ------------------------------ окно и прогноз ------------------------------ */

test('окно отправки — по Киеву, а не по часам сервера', () => {
  const sender = { window_from: '08:00', window_to: '21:00' };
  assert.equal(throttle.windowState(sender, Date.parse('2026-09-14T09:00:00Z')).open, true, '12:00 по Киеву');
  const early = throttle.windowState(sender, Date.parse('2026-09-14T04:30:00Z'));
  assert.equal(early.open, false, '07:30 по Киеву');
  assert.equal(new Date(early.opensAt).toISOString(), '2026-09-14T05:00:00.000Z');
  const late = throttle.windowState(sender, Date.parse('2026-09-14T18:30:00Z'));
  assert.equal(late.open, false, '21:30 по Киеву');
  assert.equal(new Date(late.opensAt).toISOString(), '2026-09-15T05:00:00.000Z', 'откроется завтра в 08:00');
  // Зимой Киев — UTC+2: окно сдвигается вместе с поясом.
  assert.equal(new Date(throttle.windowState(sender, Date.parse('2026-12-01T03:00:00Z')).opensAt).toISOString(), '2026-12-01T06:00:00.000Z');
});

test('прогноз: 120 писем при потолке 50 — третий день', () => {
  const sender = { window_from: '08:00', window_to: '21:00' };
  const quick = throttle.forecast({ sender, remaining: 10, capLeft: 50, cap: 50, now: NOON });
  assert.equal(quick.days, 0);
  assert.ok(quick.finishAt - NOON < 5 * 60000, 'десять писем — за пару минут');
  const long = throttle.forecast({ sender, remaining: 120, capLeft: 50, cap: 50, now: NOON });
  assert.equal(long.days, 2);
});

/* ------------------------------ расписание ------------------------------ */

test('«разослать сейчас» — только владелец; запланировать можно только утверждённое', () => {
  const c = approvedCampaign({ title: 'Права' });
  assert.throws(() => runner.scheduleCampaign(c.id, { at: null, user: smm, now: NOON }), /только владелец/);
  const later = runner.scheduleCampaign(c.id, { at: new Date(NOON + 3600000).toISOString(), user: smm, now: NOON });
  assert.equal(later.status, 'scheduled');
  assert.equal(runner.unscheduleCampaign(c.id, { user: smm, now: NOON }).status, 'approved');
  const draft = campaigns.createCampaign(projectId, {});
  assert.throws(() => runner.scheduleCampaign(draft.id, { user: owner, now: NOON }), /утверждённое/);
  campaigns.removeCampaign(c.id);
  campaigns.removeCampaign(draft.id);
});

/* ------------------------------ отправка ------------------------------ */

let main;

test('снимок: человек в двух базах — одно письмо, отписавшийся — ни одного; ссылки короткие', async () => {
  main = approvedCampaign({ title: 'Основная' });
  runner.scheduleCampaign(main.id, { user: owner, now: NOON });
  const google = fakeGoogle();
  const { started } = await runner.mailStep({ now: NOON, fetchImpl: google });
  assert.deepEqual(started, [main.id]);

  const rows = db.prepare('SELECT email, status FROM mail_sends WHERE campaign_id = ? ORDER BY email').all(main.id);
  assert.deepEqual(rows.map((r) => r.email), ['a@example.com', 'b@example.com', 'both@example.com']);
  assert.equal(google.sent.length, 1, 'за шаг ящик отправляет одно письмо');

  const map = JSON.parse(db.prepare('SELECT link_map FROM mail_campaigns WHERE id = ?').get(main.id).link_map);
  assert.equal(Object.keys(map).length, 2, 'кнопка и ссылка в тексте');
  const link = db.prepare("SELECT target_url FROM links WHERE mail_campaign_id = ? AND target_url LIKE '%trial%'").get(main.id);
  assert.match(link.target_url, /utm_source=email/);
  assert.match(google.sent[0].raw, /smm\.example\/r\//);
  assert.match(google.sent[0].raw, /List-Unsubscribe: <https:\/\/smm\.example\/u\//);
});

test('пауза между письмами держит ящик; отписка посреди рассылки снимает письмо из очереди', async () => {
  const google = fakeGoogle();
  const out = await runner.mailStep({ now: NOON + 1000, fetchImpl: google });
  assert.equal(out.results[senderId], 'gap', 'меньше 4 секунд после письма — ждём');
  assert.equal(google.sent.length, 0);

  const queuedB = db.prepare("SELECT status FROM mail_sends WHERE campaign_id = ? AND email = 'b@example.com'").get(main.id).status;
  if (queuedB === 'queued') {
    store.selfUnsubscribe(contacts.b, projectId, { source: 'page' });
    assert.equal(db.prepare("SELECT status FROM mail_sends WHERE campaign_id = ? AND email = 'b@example.com'").get(main.id).status, 'skipped');
  }
  await drain(google);
  const final = campaigns.getCampaign(main.id);
  assert.equal(final.status, 'done');
  assert.equal(final.progress.queued, 0);
  assert.ok(!google.sent.some((s) => s.to === 'b@example.com'), 'отписавшемуся письмо не ушло');
  const personal = google.sent.find((s) => s.to === 'both@example.com');
  if (personal) assert.match(personal.raw, /=D0=86=D1=80=D0=B8=D0=BD=D0=B0|Ірина/, 'имя подставлено');
});

test('нет ответа Google — «судьба неизвестна» и без повтора; плохой адрес — в стоп-лист', async () => {
  store.selfResubscribe(contacts.b, projectId);
  const c = approvedCampaign({ title: 'Сбои', include: [pupils.id, parents.id] });
  runner.scheduleCampaign(c.id, { user: owner, now: NOON });
  let calls = 0;
  const google = fakeGoogle((to) => {
    calls++;
    if (to === 'a@example.com') return 'hang';
    if (to === 'b@example.com') return 'bad-address';
    return 'ok';
  });
  await drain(google);
  const byEmail = Object.fromEntries(db.prepare('SELECT email, status FROM mail_sends WHERE campaign_id = ?').all(c.id).map((r) => [r.email, r.status]));
  assert.equal(byEmail['a@example.com'], 'unknown');
  assert.equal(byEmail['b@example.com'], 'failed');
  assert.equal(byEmail['both@example.com'], 'sent');
  assert.equal(calls, 3, 'каждому адресу — ровно одна попытка');
  assert.equal(db.prepare('SELECT status FROM mail_contacts WHERE id = ?').get(contacts.b).status, 'invalid');
  assert.ok(store.isSuppressed(projectId, 'b@example.com'));
  assert.equal(campaigns.getCampaign(c.id).status, 'done');
});

test('Google просит медленнее — письмо назад в очередь, ящик придержан до названного времени', async () => {
  db.prepare("UPDATE mail_contacts SET status = 'active' WHERE id = ?").run(contacts.a);
  const c = approvedCampaign({ title: 'Лимит', include: [pupils.id] });
  runner.scheduleCampaign(c.id, { user: owner, now: NOON });
  const google = fakeGoogle(() => 'rate');
  const out = await runner.mailStep({ now: NOON, fetchImpl: google });
  assert.equal(out.results[senderId], 'rate');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_sends WHERE campaign_id = ? AND status = 'queued'").get(c.id).n, 2);
  assert.equal(db.prepare('SELECT paused_until FROM mail_senders WHERE id = ?').get(senderId).paused_until, '2026-09-14T09:30:00Z');
  runner.resetPacing();
  assert.equal((await runner.mailStep({ now: NOON + 60000, fetchImpl: google })).results[senderId], 'hold');

  // Отмена: очередь не уйдёт, ящик свободен для других.
  const cancelled = runner.cancelCampaign(c.id, { user: owner, now: NOON });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.progress.cancelled, 2);
  db.prepare('UPDATE mail_senders SET paused_until = NULL, hold_reason = NULL WHERE id = ?').run(senderId);
});

test('окно закрыто и потолок суток — письма ждут', async () => {
  const c = approvedCampaign({ title: 'Ночь', include: [pupils.id] });
  runner.scheduleCampaign(c.id, { user: owner, now: NOON });
  const google = fakeGoogle();
  const night = Date.parse('2026-09-14T20:00:00Z'); // 23:00 по Киеву
  runner.resetPacing();
  assert.equal((await runner.mailStep({ now: night, fetchImpl: google })).results[senderId], 'window');

  const cap = senders.capOf(db.prepare('SELECT * FROM mail_senders WHERE id = ?').get(senderId), NOON).effective;
  const used = senders.usage24h(senderId, NOON);
  const fill = db.prepare("INSERT INTO mail_test_sends (sender_id, to_email, gmail_id, sent_at) VALUES (?, 'x@example.com', 'x', ?)");
  for (let i = used; i < cap; i++) fill.run(senderId, new Date(NOON - 60000).toISOString());
  runner.resetPacing();
  assert.equal((await runner.mailStep({ now: NOON, fetchImpl: google })).results[senderId], 'cap');
  assert.equal(google.sent.length, 0);

  // Пауза и продолжение.
  assert.equal(runner.pauseCampaign(c.id, { user: owner, now: NOON }).status, 'paused');
  assert.equal(runner.resumeCampaign(c.id, { user: owner, now: NOON }).status, 'sending');
  runner.cancelCampaign(c.id, { user: owner, now: NOON });
  db.prepare("DELETE FROM mail_test_sends WHERE to_email = 'x@example.com'").run();
});

test('зависшее «отправляется» — через 10 минут судьба неизвестна', () => {
  const c = approvedCampaign({ title: 'Сбой процесса', include: [pupils.id] });
  runner.scheduleCampaign(c.id, { user: owner, now: NOON });
  runner.startDue(NOON);
  db.prepare("UPDATE mail_sends SET status = 'sending', sending_since = ? WHERE campaign_id = ?").run(new Date(NOON - 11 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'), c.id);
  assert.equal(runner.recoverStuck(NOON), 2);
  assert.equal(campaigns.progressOf(c.id).unknown, 2);
  // Письма с неизвестной судьбой считаются в потолок: Google мог их принять.
  assert.ok(senders.usage24h(senderId, NOON) >= 2);
});

test('картинки разосланного письма снимаются, но не пока их держит копия', async () => {
  const c = approvedCampaign({ title: 'С картинкой', include: [pupils.id], withImage: true });
  const copy = campaigns.copyCampaign(c.id, {});
  const file = resolve(process.env.MAIL_MEDIA_DIR, Object.values(c.media)[0].name);
  runner.scheduleCampaign(c.id, { user: owner, now: NOON });
  const google = fakeGoogle();
  await drain(google, { steps: 6 });
  assert.equal(campaigns.getCampaign(c.id).status, 'done');
  assert.match(google.sent.at(-1).raw, /Content-ID: <m\d+\.\d+@mail\.panel>/);

  const later = NOON + 3600000;
  runner.purgeMedia(later);
  assert.ok(existsSync(file), 'копия-черновик держит файл');
  campaigns.removeCampaign(copy.id);
  db.prepare('UPDATE mail_campaigns SET deleted_at = ? WHERE id = ?').run(new Date(NOON).toISOString(), copy.id);
  runner.purgeMedia(later);
  assert.ok(!existsSync(file), 'живых писем с этим файлом нет — снят');
  assert.ok(campaigns.getCampaign(c.id).media[Object.keys(c.media)[0]].purged);
});

test('стирание по просьбе убирает адрес и из истории рассылок', () => {
  store.erase(contacts.both);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_sends WHERE email = 'both@example.com'").get().n, 0);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM mail_sends WHERE email LIKE 'erased-%'").get().n > 0);
});
