/**
 * Подписка с сайтов: форма → письмо-подтверждение → база «Подписка с сайта».
 *
 *   — чужой сайт форму не отправит, робот в ловушке не получит письма;
 *   — в базу попадает только нажавший кнопку в письме, GET по ссылке не подписывает;
 *   — ответ формы не выдаёт, подписан ли адрес;
 *   — повторная отправка формы не заваливает человека письмами.
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
const BASE = { school: 'education', origin: 'https://mycomputer.education', page: 'https://mycomputer.education/', publicBase: 'https://smm.example' };

function google() {
  const sent = [];
  const fn = async (url, init = {}) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'A', expires_in: 3600 }) };
    sent.push(Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8'));
    return { ok: true, status: 200, json: async () => ({ id: `g${sent.length}` }) };
  };
  fn.sent = sent;
  return fn;
}

const tokenIn = (raw) => {
  // Тело письма — quoted-printable: мягкие переносы строк склеиваем обратно.
  const body = raw.replace(/=\r?\n/g, '');
  return /\/s\/confirm\/([A-Za-z0-9_-]+)/.exec(body)?.[1];
};

before(() => {
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

test('чужой сайт, неизвестная школа, робот в ловушке, ошибка в адресе', async () => {
  const fetchImpl = google();
  assert.equal((await signups.subscribe({ ...BASE, email: 'a@example.com', origin: 'https://evil.example', fetchImpl, now: NOW })).status, 403);
  assert.equal((await signups.subscribe({ ...BASE, email: 'a@example.com', school: 'nope', fetchImpl, now: NOW })).status, 400);
  const bot = await signups.subscribe({ ...BASE, email: 'a@example.com', honeypot: 'http://spam', ip: '1.1.1.1', fetchImpl, now: NOW });
  assert.equal(bot.ok, true, 'роботу отвечаем как человеку');
  assert.equal(fetchImpl.sent.length, 0);
  assert.equal((await signups.subscribe({ ...BASE, email: 'не адрес', ip: '1.1.1.2', fetchImpl, now: NOW })).status, 400);
  const typo = await signups.subscribe({ ...BASE, email: 'ivan@gmial.com', ip: '1.1.1.3', fetchImpl, now: NOW });
  assert.equal(typo.suggestion, 'ivan@gmail.com');
  assert.equal(typo.code, 'typo', 'по коду сайт выбирает текст на своём языке');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mail_signups').get().n, 0);
});

let token;

test('подписка: письмо с кнопкой, без заголовка отписки; повтор формы не шлёт второе письмо', async () => {
  const fetchImpl = google();
  const out = await signups.subscribe({ ...BASE, email: 'Olga@Example.com', ip: '2.2.2.2', fetchImpl, now: NOW });
  assert.equal(out.ok, true);
  assert.equal(fetchImpl.sent.length, 1);
  assert.doesNotMatch(fetchImpl.sent[0], /List-Unsubscribe/);
  token = tokenIn(fetchImpl.sent[0]);
  assert.ok(token, 'в письме ссылка подтверждения');
  assert.equal(db.prepare("SELECT token_hash FROM mail_signups WHERE email = 'olga@example.com'").get().token_hash.length, 64, 'в базе хеш, не токен');

  const again = await signups.subscribe({ ...BASE, email: 'olga@example.com', ip: '2.2.2.3', fetchImpl, now: NOW + 60000 });
  assert.equal(again.message, out.message, 'ответ тот же');
  assert.equal(fetchImpl.sent.length, 1, 'через минуту второго письма нет');
});

test('GET по ссылке не подписывает, кнопка — подписывает в базу «Подписка с сайта»', () => {
  const page = signups.confirmPage({ token, method: 'GET', now: NOW });
  assert.match(page.html, /Підтвердити підписку/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_contacts WHERE email = 'olga@example.com'").get().n, 0);

  const done = signups.confirmPage({ token, method: 'POST', now: NOW });
  assert.match(done.html, /ви підписані/);
  const contact = db.prepare("SELECT id, status FROM mail_contacts WHERE email = 'olga@example.com'").get();
  assert.equal(contact.status, 'active');
  const list = db.prepare('SELECT l.name, l.consent_basis FROM mail_list_members m JOIN mail_lists l ON l.id = m.list_id WHERE m.contact_id = ?').get(contact.id);
  assert.deepEqual({ ...list }, { name: 'Подписка с сайта', consent_basis: 'form' });
  assert.match(signups.confirmPage({ token, method: 'POST', now: NOW }).html, /вже підтверджено/);
});

test('уже подписанному письмо не уходит, ответ формы тот же', async () => {
  const fetchImpl = google();
  const out = await signups.subscribe({ ...BASE, email: 'olga@example.com', ip: '3.3.3.3', fetchImpl, now: NOW + 3600000 });
  assert.equal(out.ok, true);
  assert.equal(fetchImpl.sent.length, 0);
});

test('отписавшийся раньше, подтвердив подписку, снова получает письма', async () => {
  const projectId = db.prepare("SELECT id FROM projects WHERE slug = 'education'").get().id;
  const list = store.createList(projectId, { name: 'Старі', consentBasis: 'client' });
  const { contactId } = store.addContactManually({ listId: list.id, email: 'back@example.com' });
  store.selfUnsubscribe(contactId, projectId, { source: 'page' });

  const fetchImpl = google();
  await signups.subscribe({ ...BASE, email: 'back@example.com', ip: '4.4.4.4', fetchImpl, now: NOW });
  signups.confirmPage({ token: tokenIn(fetchImpl.sent[0]), method: 'POST', now: NOW });
  assert.equal(store.isSuppressed(projectId, 'back@example.com'), false);
  assert.equal(db.prepare('SELECT status FROM mail_contacts WHERE id = ?').get(contactId).status, 'active');
});

test('старая ссылка не подписывает; частые попытки с одного адреса закрываются', async () => {
  const fetchImpl = google();
  await signups.subscribe({ ...BASE, email: 'late@example.com', ip: '5.5.5.5', fetchImpl, now: NOW });
  const stale = signups.confirmPage({ token: tokenIn(fetchImpl.sent[0]), method: 'POST', now: NOW + 8 * 86400000 });
  assert.equal(stale.status, 410);
  assert.equal(signups.confirmPage({ token: 'поддельный', method: 'GET', now: NOW }).status, 404);

  resetAll();
  let last;
  for (let i = 0; i < 6; i++) last = await signups.subscribe({ ...BASE, email: `spam${i}@example.com`, ip: '6.6.6.6', fetchImpl, now: NOW });
  assert.equal(last.status, 429);
  assert.equal(signups.signupStats(db.prepare("SELECT id FROM projects WHERE slug = 'education'").get().id, NOW).confirmed, 2);
});
