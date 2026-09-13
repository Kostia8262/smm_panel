/**
 * Рассылка, фаза 2: письмо, подключение Gmail, потолки, отписка.
 *
 * Сеть подменена: Google отвечает тем, что мы ему велели. Проверяется то,
 * ошибку в чём видит получатель или Google, а не мы: заголовки письма,
 * отказ без права gmail.send, потолок ящика, отписка по ссылке и то, что
 * GET эту отписку не делает.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-mail2-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const staff = await import('../src/staff.js');
const store = await import('../src/mail/store.js');
const mime = await import('../src/mail/compose/mime.js');
const googleOauth = await import('../src/mail/sender/google-oauth.js');
const gmail = await import('../src/mail/sender/gmail.js');
const senders = await import('../src/mail/sender/senders.js');
const unsubscribe = await import('../src/mail/unsubscribe.js');

let projectId;
let ownerId;

before(() => {
  db.exec("INSERT INTO projects (slug, title, position) VALUES ('mail2', 'Комп''ютерна академія', 90)");
  projectId = db.prepare("SELECT id FROM projects WHERE slug = 'mail2'").get().id;
  ownerId = staff.create({ name: 'Владелец', role: 'owner' }).id;
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // База может быть ещё занята — временный каталог подчистит система.
  }
});

const fakeIdToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;

/** Подделка fetch: маршрут → ответ. Запоминает, что у неё спрашивали. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes.find(([match]) => String(url).includes(match));
    if (!route) throw new Error(`неожиданный запрос ${url}`);
    const [, status, body] = route;
    if (status === 'network') throw new Error('socket hang up');
    return { ok: status < 400, status, json: async () => (typeof body === 'function' ? body(init) : body) };
  };
  fn.calls = calls;
  return fn;
}

/* ---------------------------------- письмо ---------------------------------- */

test('тема и имя кириллицей кодируются кусками, буква не рвётся', () => {
  const subject = 'Пробний лист — Комп\'ютерна академія та дуже довга тема з емодзі 🎓 наприкінці';
  const encoded = mime.encodeWord(subject);
  const words = encoded.split('\r\n ');
  assert.ok(words.length > 1, 'длинная тема — несколько encoded-word');
  for (const w of words) {
    assert.ok(w.length <= 75, `кусок длиннее 75 знаков: ${w.length}`);
    const inner = Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(w)[1], 'base64').toString('utf8');
    assert.ok(!inner.includes('�'), 'буква разрезана между кусками');
  }
  const joined = words.map((w) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(w)[1], 'base64').toString('utf8')).join('');
  assert.equal(joined, subject);
  assert.equal(mime.encodeWord('Hello'), 'Hello');
});

test('перевод строки в теме и имени не дописывает заголовков', () => {
  const message = mime.buildMessage({
    from: { name: 'Школа\r\nBcc: spy@example.com', email: 'school@example.com' },
    to: { email: 'ira@example.com' },
    subject: 'Привіт\nBcc: spy@example.com',
    text: 'текст',
  });
  const head = message.split('\r\n\r\n')[0];
  assert.ok(!/^Bcc:/im.test(head), 'в заголовках появился Bcc');
  assert.throws(() => mime.formatAddress({ email: 'a@b.com>\r\nBcc: x@y.z' }), /Некорректный адрес/);
  assert.throws(() => mime.buildMessage({ from: { email: 'a@b.com' }, to: { email: 'c@d.com' }, subject: 's', text: 't', headers: { 'X-Bad\r\n': 'v' } }), /Недопустимое имя/);
});

test('quoted-printable: строки не длиннее 76, кириллица и «=» кодируются, текст восстанавливается', () => {
  const text = `${'Дуже довгий рядок українською, що точно перевищить межу. '.repeat(3)}\n2 + 2 = 4 \nкінець`;
  const qp = mime.quotedPrintable(text);
  for (const line of qp.split('\r\n')) assert.ok(line.length <= 76, `строка ${line.length}: ${line}`);
  assert.ok(!/ \r\n/.test(qp), 'пробел в конце строки не закодирован — сервер его срежет');

  // Обратное преобразование: мягкие переносы долой, =XX — в байты.
  const joined = qp.replace(/=\r\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=') {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(joined.charCodeAt(i));
  }
  assert.equal(Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n'), text);
});

test('письмо с HTML — multipart/alternative, заголовки отписки на месте', () => {
  const message = mime.buildMessage({
    from: { name: 'Академія', email: 'school@example.com' },
    to: { email: 'ira@example.com' },
    subject: 'Тема',
    text: 'Текст',
    html: '<p>HTML</p>',
    headers: unsubscribe.unsubscribeHeaders('https://smm.example/u/abc.def'),
  });
  assert.match(message, /^From: =\?UTF-8\?B\?.+\?= <school@example\.com>\r\n/m);
  assert.match(message, /Content-Type: multipart\/alternative; boundary="mc_[0-9a-f]+"/);
  assert.match(message, /List-Unsubscribe: <https:\/\/smm\.example\/u\/abc\.def>/);
  assert.match(message, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.ok(message.includes('text/plain') && message.includes('text/html'));
  assert.ok(!message.split('\r\n').some((l) => l.length > 998));
  assert.equal(Buffer.from(mime.toBase64Url(message), 'base64url').toString('utf8'), message);
});

/* ----------------------------- подключение Google ----------------------------- */

test('окно согласия просит ровно три права, долгий доступ и повторное согласие', () => {
  const url = new URL(googleOauth.authorizeUrl({ clientId: 'id.apps.googleusercontent.com', redirectUri: 'https://x/oauth/google', state: 's' }));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.deepEqual(url.searchParams.get('scope').split(' ').sort(), [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email',
    'openid',
  ]);
});

test('без галочки gmail.send ящик не подключается', async () => {
  const fetchImpl = fakeFetch([
    ['oauth2.googleapis.com/token', 200, { access_token: 'a', refresh_token: 'r', scope: 'openid https://www.googleapis.com/auth/userinfo.email', id_token: fakeIdToken('box@gmail.com') }],
  ]);
  await assert.rejects(
    googleOauth.exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'u', code: 'k', fetchImpl }),
    (err) => err.kind === 'denied' && /Отправлять письма/.test(err.message)
  );
});

test('временный доступ (режим Testing) виден по сроку, адрес — из id_token', async () => {
  const fetchImpl = fakeFetch([
    [
      'oauth2.googleapis.com/token',
      200,
      {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3599,
        refresh_token_expires_in: 604799,
        scope: 'openid https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email',
        id_token: fakeIdToken('Box@Gmail.com'),
      },
    ],
  ]);
  const now = Date.parse('2026-09-13T10:00:00Z');
  const out = await googleOauth.exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'u', code: 'k', fetchImpl, now });
  assert.equal(out.email, 'box@gmail.com');
  assert.equal(out.refreshExpiresAt, '2026-09-20T09:59:59.000Z');
});

test('invalid_grant — это смерть доступа, а не временный сбой', async () => {
  const fetchImpl = fakeFetch([['oauth2.googleapis.com/token', 400, { error: 'invalid_grant' }]]);
  await assert.rejects(googleOauth.refreshAccess({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl }), (err) => err.kind === 'dead');
});

/* ------------------------------- ответы Gmail ------------------------------- */

test('ответы Gmail: лимит, темп, выключенный API, адрес и «не знаем»', async () => {
  assert.equal(gmail.classify(403, { error: { message: 'Daily user sending limit exceeded.', errors: [{ reason: 'dailyLimitExceeded' }] } }).kind, 'daily');
  const rate = gmail.classify(429, { error: { message: 'User-rate limit exceeded.  Retry after 2026-09-13T12:00:00.000Z', errors: [{ reason: 'rateLimitExceeded' }] } });
  assert.equal(rate.kind, 'rate');
  assert.equal(rate.retryAt, '2026-09-13T12:00:00.000Z');
  assert.equal(gmail.classify(403, { error: { message: 'Gmail API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } }).kind, 'config');
  assert.equal(gmail.classify(400, { error: { message: 'Invalid To header' } }).kind, 'recipient');
  assert.equal(gmail.classify(401, {}).kind, 'auth');
  assert.equal(gmail.classify(503, {}).sent, false, 'ответ с ошибкой — письмо точно не ушло');

  const hang = fakeFetch([['gmail.googleapis.com', 'network']]);
  await assert.rejects(gmail.sendRaw({ accessToken: 't', raw: 'x', fetchImpl: hang }), (err) => err.kind === 'unknown' && err.sent === null);
});

/* ---------------------------- ящики и потолки ---------------------------- */

let senderId;

test('подключённый ящик: токен в базе только шифротекстом, прогрев включён сам', () => {
  const now = Date.parse('2026-09-13T10:00:00Z');
  const sender = senders.saveConnected({ email: 'box@gmail.com', refreshToken: 'REFRESH-SECRET-123', scopes: ['openid'], staffId: ownerId }, now);
  senderId = sender.id;
  const dump = JSON.stringify(db.prepare('SELECT * FROM mail_senders').all());
  assert.ok(!dump.includes('REFRESH-SECRET-123'), 'refresh-токен лежит открытым');
  assert.equal(sender.kind, 'gmail');
  assert.equal(sender.warmup, true);
  assert.deepEqual(sender.cap, { google: 500, panel: 400, warmupDay: 1, warmupCap: 50, effective: 50 });
});

test('потолок: прогрев растёт по дням, свой потолок не выше Google, без прогрева — 80 %', () => {
  const start = Date.parse('2026-09-13T10:00:00Z');
  const row = { kind: 'gmail', daily_cap: null, warmup_from: '2026-09-13T10:00:00Z' };
  assert.equal(senders.capOf(row, start + 5 * 86400000).effective, 100);
  assert.equal(senders.capOf(row, start + 30 * 86400000).effective, 400);
  assert.equal(senders.capOf({ ...row, warmup_from: null }, start).effective, 400);
  assert.equal(senders.capOf({ kind: 'workspace', daily_cap: null, warmup_from: null }, start).effective, 1600);
  assert.throws(() => senders.updateSender(senderId, { dailyCap: 900 }), /от 1 до 500/);
  assert.throws(() => senders.updateSender(senderId, { windowFrom: '22:00', windowTo: '21:00' }), /раньше/);
});

test('Client ID проверяется, секрет не затирается пустым полем', () => {
  assert.throws(() => senders.saveGoogleApp({ clientId: 'не то', clientSecret: 's' }), /googleusercontent/);
  senders.saveGoogleApp({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
  senders.saveGoogleApp({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: '' });
  assert.equal(senders.googleApp().clientSecret, 'GOCSPX-secret');
  const raw = db.prepare("SELECT value FROM settings WHERE key = 'google_client_secret'").get().value;
  assert.ok(!raw.includes('GOCSPX'), 'секрет приложения лежит открытым');
});

test('пробное письмо уходит, пишется в счётчик и упирается в потолок', async () => {
  const now = Date.parse('2026-09-13T11:00:00Z');
  let sentRaw = null;
  const fetchImpl = fakeFetch([
    ['oauth2.googleapis.com/token', 200, { access_token: 'ACCESS', expires_in: 3600 }],
    [
      'gmail.googleapis.com',
      200,
      (init) => {
        sentRaw = JSON.parse(init.body).raw;
        return { id: 'gmail-1', threadId: 't' };
      },
    ],
  ]);
  const result = await senders.sendTest(senderId, { projectId, staffId: ownerId, publicBase: 'https://smm.example', fetchImpl, now });
  assert.deepEqual(result.sent.map((s) => s.email), ['box@gmail.com'], 'по умолчанию — себе');
  assert.equal(senders.usage24h(senderId, now), 1);

  const letter = Buffer.from(sentRaw, 'base64url').toString('utf8');
  assert.match(letter, /List-Unsubscribe: <https:\/\/smm\.example\/u\/[\w-]+\.[\w-]+>/);
  const auth = fetchImpl.calls.find((c) => c.url.includes('gmail.googleapis.com')).init.headers.Authorization;
  assert.equal(auth, 'Bearer ACCESS');

  for (let i = 0; i < 49; i++) db.prepare("INSERT INTO mail_test_sends (sender_id, to_email, sent_at) VALUES (?, 'x@example.com', '2026-09-13T10:30:00Z')").run(senderId);
  await assert.rejects(senders.sendTest(senderId, { projectId, publicBase: 'https://smm.example', fetchImpl, now }), /Потолок ящика/);
  assert.equal(senders.usage24h(senderId, now + 86400000), 0, 'окно скользящее — через сутки счётчик пуст');
});

test('смерть доступа отмечается на ящике', async () => {
  const fetchImpl = fakeFetch([['oauth2.googleapis.com/token', 400, { error: 'invalid_grant' }]]);
  await assert.rejects(senders.checkSender(senderId, { fetchImpl, now: Date.now() + 7200000 }), (err) => err.kind === 'dead');
  assert.equal(senders.getSender(senderId).state, 'dead');
  assert.equal(senders.senderAlerts().worst, 'danger');
});

/* ---------------------------------- отписка ---------------------------------- */

const title = () => 'Комп\'ютерна академія';

test('ссылку отписки не подделать и не перебрать', () => {
  const token = unsubscribe.tokenFor({ projectId, contactId: 42, campaignId: 7 });
  assert.deepEqual(unsubscribe.readToken(token), { projectId, contactId: 42, campaignId: 7, test: false });
  const [payload, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ p: projectId, c: 43, m: 7 })).toString('base64url');
  assert.equal(unsubscribe.readToken(`${forged}.${mac}`), null, 'чужой номер с той же подписью');
  assert.equal(unsubscribe.readToken(`${payload}.${mac.slice(0, -1)}x`), null);
  assert.equal(unsubscribe.readToken('мусор'), null);
});

test('GET не отписывает, POST отписывает, «я випадково» возвращает', () => {
  const list = store.createList(projectId, { name: 'Отписка', consentBasis: 'form' });
  const { contactId } = store.addContactManually({ listId: list.id, email: 'reader@example.com' });
  const token = unsubscribe.tokenFor({ projectId, contactId, campaignId: 0 + 5 });

  const shown = unsubscribe.handle({ token, method: 'GET', projectTitle: title });
  assert.equal(shown.status, 200);
  assert.match(shown.html, /Відписатися від листів\?/);
  assert.equal(store.isSuppressed(projectId, 'reader@example.com'), false, 'сканер ссылок, открывший GET, отписал человека');

  const done = unsubscribe.handle({ token, method: 'POST', body: { action: 'unsubscribe' }, projectTitle: title });
  assert.match(done.html, /ви відписані/);
  assert.equal(store.isSuppressed(projectId, 'reader@example.com'), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_events WHERE type = 'unsubscribed' AND contact_id = ?").get(contactId).n, 1);

  const again = unsubscribe.handle({ token, method: 'POST', body: { action: 'unsubscribe' }, projectTitle: title });
  assert.equal(again.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_events WHERE type = 'unsubscribed' AND contact_id = ?").get(contactId).n, 1, 'повторная отписка не плодит событий');

  const back = unsubscribe.handle({ token, method: 'POST', body: { action: 'resubscribe' }, projectTitle: title });
  assert.match(back.html, /Підписку повернуто/);
  assert.equal(store.isSuppressed(projectId, 'reader@example.com'), false);
});

test('one-click почтовой программы отписывает без страницы; отписку владельца страница не отменяет', () => {
  const list = store.createList(projectId, { name: 'Одним нажатием', consentBasis: 'form' });
  const { contactId } = store.addContactManually({ listId: list.id, email: 'oneclick@example.com' });
  const token = unsubscribe.tokenFor({ projectId, contactId, campaignId: 9 });
  const out = unsubscribe.handle({ token, method: 'POST', body: { 'List-Unsubscribe': 'One-Click' }, projectTitle: title });
  assert.deepEqual(out, { status: 200, text: 'OK' });
  assert.equal(store.isSuppressed(projectId, 'oneclick@example.com'), true);

  const other = store.addContactManually({ listId: list.id, email: 'manual@example.com' });
  store.bulk({ projectId, ids: [other.contactId], action: 'unsubscribe', note: 'попросил по телефону' });
  const manualToken = unsubscribe.tokenFor({ projectId, contactId: other.contactId, campaignId: 9 });
  const refused = unsubscribe.handle({ token: manualToken, method: 'POST', body: { action: 'resubscribe' }, projectTitle: title });
  assert.match(refused.html, /Не вдалося повернути/);
  assert.equal(store.isSuppressed(projectId, 'manual@example.com'), true);
});

test('пробное письмо: ссылка работает и ничего не меняет, битая ссылка — 404 с объяснением', () => {
  const token = unsubscribe.tokenFor({ projectId, contactId: 0, campaignId: 0 });
  const out = unsubscribe.handle({ token, method: 'GET', projectTitle: title });
  assert.match(out.html, /Це пробний лист/);
  assert.equal(unsubscribe.handle({ token: 'abc.def', method: 'GET', projectTitle: title }).status, 404);
  const xss = unsubscribe.handle({ token, method: 'GET', projectTitle: () => '<script>alert(1)</script>' });
  assert.ok(!xss.html.includes('<script>'), 'название школы не экранировано');
});
