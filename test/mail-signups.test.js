/**
 * Подписка с сайтов: форма → база «Подписка с сайта» → приветственное письмо.
 *
 *   — чужой сайт форму не отправит, без кода согласия подписка не принимается,
 *     робот в ловушке не получит письма;
 *   — новый адрес сразу в базе, с доказательством согласия и источником;
 *   — отказавшемуся подписку возвращает только кнопка в письме, а ответ формы
 *     этого не выдаёт;
 *   — домен без почты не попадает в базу, повтор формы не шлёт второе письмо;
 *   — всплеск подписок за сутки откладывается без писем и поднимает тревогу.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-mail6-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');
process.env.MAIL_MEDIA_DIR = join(dir, 'mail-media');
process.env.UPLOAD_DIR = join(dir, 'uploads');

const { db } = await import('../src/db.js');
const store = await import('../src/mail/store.js');
const senders = await import('../src/mail/sender/senders.js');
const signups = await import('../src/mail/signups.js');
const { resetAll } = await import('../src/ratelimit.js');

const NOW = Date.parse('2026-09-14T09:00:00Z');
const mxCheck = async (domain) => (domain === 'nomail.example' ? 'none' : 'ok');
const BASE = {
  school: 'education',
  origin: 'https://mycomputer.education',
  page: 'https://mycomputer.education/',
  consentVersion: 'footer-2026-09-uk',
  lang: 'uk',
  publicBase: 'https://smm.example',
  mxCheck,
};
let projectId;
let ipSeq = 0;
const ip = () => `10.0.0.${++ipSeq}`;

function google() {
  const sent = [];
  const fn = async (url, init = {}) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'A', expires_in: 3600 }) };
    sent.push(Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8').replace(/=\r?\n/g, ''));
    return { ok: true, status: 200, json: async () => ({ id: `g${sent.length}` }) };
  };
  fn.sent = sent;
  return fn;
}

const tokenIn = (raw) => /\/s\/confirm\/([A-Za-z0-9_-]+)/.exec(raw)?.[1];
const signupRow = (email) => db.prepare('SELECT * FROM mail_signups WHERE email = ? ORDER BY id DESC').get(email);

before(() => {
  projectId = db.prepare("SELECT id FROM projects WHERE slug = 'education'").get().id;
  senders.saveGoogleApp({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'secret' });
  senders.saveConnected({ email: 'box@gmail.com', refreshToken: 'r' });
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Временный каталог подчистит система.
  }
});

test('чужой сайт, неизвестная школа, нет кода согласия, робот, ошибка и домен без почты', async () => {
  const fetchImpl = google();
  assert.equal((await signups.subscribe({ ...BASE, email: 'a@example.com', origin: 'https://evil.example', fetchImpl, now: NOW })).status, 403);
  assert.equal((await signups.subscribe({ ...BASE, email: 'a@example.com', school: 'nope', fetchImpl, now: NOW })).status, 400);
  assert.equal((await signups.subscribe({ ...BASE, email: 'a@example.com', consentVersion: '', fetchImpl, now: NOW })).code, 'consent_missing');
  const bot = await signups.subscribe({ ...BASE, email: 'a@example.com', honeypot: 'http://spam', ip: ip(), fetchImpl, now: NOW });
  assert.equal(bot.ok, true, 'роботу отвечаем как человеку');
  assert.equal((await signups.subscribe({ ...BASE, email: 'не адрес', ip: ip(), fetchImpl, now: NOW })).code, 'invalid_email');
  const typo = await signups.subscribe({ ...BASE, email: 'ivan@gmial.com', ip: ip(), fetchImpl, now: NOW });
  assert.equal(typo.code, 'typo');
  assert.equal(typo.suggestion, 'ivan@gmail.com');
  assert.equal((await signups.subscribe({ ...BASE, email: 'x@nomail.example', ip: ip(), fetchImpl, now: NOW })).code, 'invalid_email');
  assert.equal(fetchImpl.sent.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_signups').get().n, 0);
});

test('стенд dev и localhost: форма отвечает «принято», но ничего не пишет и писем не шлёт', async () => {
  const fetchImpl = google();
  for (const origin of ['https://dev.mycomputer.education', 'https://python-dev.mycomputer.education', 'http://localhost:3000', 'https://staging.mycomputer.school']) {
    const out = await signups.subscribe({ ...BASE, email: 'tester@example.com', origin, ip: ip(), fetchImpl, now: NOW });
    assert.equal(out.code, 'accepted', origin);
    assert.equal(out.test, true, origin);
  }
  assert.equal((await signups.subscribe({ ...BASE, email: 'ivan@gmial.com', origin: 'https://dev.mycomputer.education', fetchImpl, now: NOW })).code, 'typo');
  assert.equal((await signups.subscribe({ ...BASE, email: 'a@example.com', consentVersion: '', origin: 'https://dev.mycomputer.education', fetchImpl, now: NOW })).code, 'consent_missing');
  assert.equal(signups.testSiteOf('https://mycomputer.education'), null, 'боевой сайт — не стенд');
  assert.equal(signups.testSiteOf('https://developer.mycomputer.education'), null, 'dev только целым словом');
  assert.equal(signups.testSiteOf('https://dev.evil.example'), null, 'чужой dev — не наш стенд');
  assert.equal(fetchImpl.sent.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_signups').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_contacts').get().n, 0);
});

test('новый адрес — сразу в базу «Подписка с сайта», приветствие с отпиской, согласие и источник записаны', async () => {
  const fetchImpl = google();
  const out = await signups.subscribe({
    ...BASE,
    email: 'Olga@Example.com',
    lang: 'ru',
    consentVersion: 'footer-2026-09-ru',
    utm: { source: 'instagram', medium: 'social', campaign: 'smm-20260914-p5' },
    referrer: 'https://l.instagram.com/',
    landingPath: '/?utm_source=instagram',
    ip: ip(),
    fetchImpl,
    now: NOW,
  });
  assert.equal(out.code, 'accepted');
  const contact = db.prepare("SELECT id, status FROM mail_contacts WHERE email = 'olga@example.com'").get();
  assert.equal(contact.status, 'active');
  const list = db.prepare('SELECT l.name, l.consent_basis FROM mail_list_members m JOIN mail_lists l ON l.id = m.list_id WHERE m.contact_id = ?').get(contact.id);
  assert.deepEqual({ ...list }, { name: 'Подписка с сайта', consent_basis: 'form' });

  const row = signupRow('olga@example.com');
  assert.equal(row.status, 'subscribed');
  assert.equal(row.consent_version, 'footer-2026-09-ru');
  assert.equal(row.lang, 'ru');
  assert.deepEqual([row.utm_source, row.utm_medium, row.utm_campaign], ['instagram', 'social', 'smm-20260914-p5']);
  assert.equal(row.referrer, 'https://l.instagram.com/');
  assert.equal(row.landing_path, '/?utm_source=instagram');

  assert.equal(fetchImpl.sent.length, 1);
  assert.match(fetchImpl.sent[0], /List-Unsubscribe: <https:\/\/smm\.example\/u\//, 'в приветствии есть отписка');
  assert.doesNotMatch(fetchImpl.sent[0], /\/s\/confirm\//, 'подтверждать не нужно');
  assert.match(db.prepare("SELECT note FROM mail_events WHERE contact_id = ? AND type = 'subscribed'").get(contact.id).note, /footer-2026-09-ru/);
});

test('повтор формы: через минуту ничего, через час — без второго приветствия', async () => {
  const fetchImpl = google();
  assert.equal((await signups.subscribe({ ...BASE, email: 'olga@example.com', ip: ip(), fetchImpl, now: NOW + 60000 })).code, 'accepted');
  assert.equal((await signups.subscribe({ ...BASE, email: 'olga@example.com', ip: ip(), fetchImpl, now: NOW + 3600000 })).code, 'accepted');
  assert.equal(fetchImpl.sent.length, 0);
});

test('отписавшемуся подписку возвращает только кнопка в письме; ответ формы тот же', async () => {
  const list = store.createList(projectId, { name: 'Старі', consentBasis: 'client' });
  const { contactId } = store.addContactManually({ listId: list.id, email: 'back@example.com' });
  store.selfUnsubscribe(contactId, projectId, { source: 'page' });

  const fetchImpl = google();
  const out = await signups.subscribe({ ...BASE, email: 'back@example.com', ip: ip(), fetchImpl, now: NOW });
  assert.equal(out.message, (await signups.subscribe({ ...BASE, email: 'fresh@example.com', ip: ip(), fetchImpl: google(), now: NOW })).message, 'по ответу не видно, что адрес отписывался');
  assert.equal(store.isSuppressed(projectId, 'back@example.com'), true, 'форма сама подписку не вернула');
  const token = tokenIn(fetchImpl.sent[0]);
  assert.ok(token, 'ушло письмо с кнопкой подтверждения');

  assert.match(signups.confirmPage({ token, method: 'GET', now: NOW }).html, /Підтвердити підписку/);
  assert.equal(store.isSuppressed(projectId, 'back@example.com'), true, 'GET не подписывает');
  assert.match(signups.confirmPage({ token, method: 'POST', now: NOW }).html, /ви підписані/);
  assert.equal(store.isSuppressed(projectId, 'back@example.com'), false);
  assert.equal(db.prepare('SELECT status FROM mail_contacts WHERE id = ?').get(contactId).status, 'active');
  assert.equal(signups.confirmPage({ token: 'поддельный', method: 'GET', now: NOW }).status, 404);
});

test('всплеск: сверх суточного предела школы подписки откладываются без писем', async () => {
  resetAll();
  db.prepare('DELETE FROM mail_signups').run();
  const fetchImpl = google();
  const limit = signups.SIGNUP_LIMITS.perSchoolPerDay;
  for (let i = 0; i < limit; i++) {
    db.prepare("INSERT INTO mail_signups (project_id, email, token_hash, status, created_at) VALUES (?, ?, ?, 'subscribed', ?)").run(projectId, `old${i}@example.com`, `h${i}`, new Date(NOW - 3600000).toISOString());
  }
  const out = await signups.subscribe({ ...BASE, email: 'flood@example.com', ip: ip(), fetchImpl, now: NOW });
  assert.equal(out.code, 'accepted');
  assert.equal(signupRow('flood@example.com').status, 'held');
  assert.equal(fetchImpl.sent.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_contacts WHERE email = 'flood@example.com'").get().n, 0);
  assert.ok(db.prepare("SELECT 1 FROM publish_log WHERE message LIKE '%всплеск подписок%'").get(), 'тревога в журнале');
});

test('доверенный прокси сайта передаёт адрес посетителя и сайт; чужому заголовкам не верим', () => {
  const headers = { 'x-subscribe-client-ip': '203.0.113.7', 'x-subscribe-origin': 'https://child.mycomputer.education' };
  assert.deepEqual(signups.requestSource({ ip: '127.0.0.1', origin: null, headers }), { ip: '203.0.113.7', origin: 'https://child.mycomputer.education' });
  assert.deepEqual(signups.requestSource({ ip: '198.51.100.1', origin: 'https://evil.example', headers }), { ip: '198.51.100.1', origin: 'https://evil.example' });
});

test('частые попытки с одного адреса закрываются', async () => {
  resetAll();
  db.prepare('DELETE FROM mail_signups').run();
  let last;
  for (let i = 0; i < 6; i++) last = await signups.subscribe({ ...BASE, email: `spam${i}@example.com`, ip: '6.6.6.6', fetchImpl: google(), now: NOW });
  assert.equal(last.status, 429);
});
