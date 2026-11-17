/**
 * Тесты-атаки security-audit 17.11.2026 по фазе 2 бота (ветка bot-phase2).
 * Перенесены из отчёта docs/SECURITY-2026-11-17-bot-phase2.md; атаки 1 и 2
 * (С1) падали до правки. Ниже — проверки гигиены Г1–Г3 того же отчёта.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'smm-sec-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');
process.env.NODE_ENV = 'test';

const { db } = await import('../src/db.js');
const projects = await import('../src/projects.js');
const knowledge = await import('../src/bot/knowledge.js');
const dialogs = await import('../src/bot/dialogs.js');
const send = await import('../src/bot/send.js');
const { mountMetaWebhook, signatureValid } = await import('../src/bot/webhook.js');
const { sameOriginOnly } = await import('../src/bot/routes.js');
const leadsSettings = await import('../src/leads-settings.js');
const staff = await import('../src/staff.js');
const crm = await import('../src/bot/crm-lead.js');
const { encrypt } = await import('../src/secrets.js');
const express = (await import('express')).default;

const IG_EDU = '17840000000000001';
const IG_SCHOOL = '17840000000000002';
const SECRET_EDU = 'edu-app-secret';
const SECRET_SCHOOL = 'school-app-secret-other-meta-app';
let edu, school, base, server;
const outbox = [];

before(async () => {
  edu = projects.getProjectBySlug('education').id;
  school = projects.getProjectBySlug('school').id;
  projects.saveAccount(edu, 'instagram', { userId: IG_EDU, pageToken: 't' }, { quiet: true });
  projects.saveAccount(edu, 'facebook', { pageId: '100000000000001', pageToken: 't', appSecret: SECRET_EDU }, { quiet: true });
  projects.saveAccount(school, 'instagram', { userId: IG_SCHOOL, pageToken: 't' }, { quiet: true });
  projects.saveAccount(school, 'facebook', { pageId: '100000000000002', pageToken: 't', appSecret: SECRET_SCHOOL }, { quiet: true });
  knowledge.saveSettings(edu, { enabled: true, autoReply: true });
  knowledge.saveSettings(school, { enabled: true, autoReply: true });
  send.setSender(async (m) => { outbox.push(m); return { mid: `m_out_${outbox.length}` }; });
  const app = express();
  mountMetaWebhook(app);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

const sign = (raw, secret) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
async function post(body, secret) {
  const raw = Buffer.from(JSON.stringify(body));
  return fetch(`${base}/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw, secret) }, body: raw });
}
let seq = 0;
const customerTo = (ig, peer, text) => ({ object: 'instagram', entry: [{ id: ig, time: Date.now(), messaging: [{ sender: { id: peer }, recipient: { id: ig }, timestamp: Date.now(), message: { mid: `m_in_${++seq}`, text } }] }] });
const echoFrom = (ig, peer, text) => ({ object: 'instagram', entry: [{ id: ig, time: Date.now(), messaging: [{ sender: { id: ig }, recipient: { id: peer }, timestamp: Date.now(), message: { mid: `m_echo_${++seq}`, text, is_echo: true } }] }] });

test('Атака 1 (С1): событие для аккаунта школы, подписанное секретом приложения академии, не должно ложиться в школу', async () => {
  const r = await post(customerTo(IG_SCHOOL, 'peer-forged-1', 'Скільки коштує? Дитині 9'), SECRET_EDU);
  const d = db.prepare('SELECT * FROM bot_dialogs WHERE peer_id = ?').get('peer-forged-1');
  // Сейчас: 200 и диалог в проекте school, план ответа от имени школы.
  assert.equal(d, undefined, `чужой секрет принят: HTTP ${r.status}, диалог #${d?.id} в проекте ${d?.project_id} (school=${school})`);
});

test('Атака 2 (С1): поддельный echo чужим секретом снимает бота с живого диалога школы', async () => {
  await post(customerTo(IG_SCHOOL, 'peer-real-2', 'Вітаю'), SECRET_SCHOOL);
  const before = db.prepare('SELECT handled_by FROM bot_dialogs WHERE peer_id = ?').get('peer-real-2');
  assert.equal(before.handled_by, 'bot');
  await post(echoFrom(IG_SCHOOL, 'peer-real-2', 'x'), SECRET_EDU);
  const after = db.prepare('SELECT handled_by FROM bot_dialogs WHERE peer_id = ?').get('peer-real-2');
  assert.equal(after.handled_by, 'bot', 'echo, подписанный секретом другого приложения, перевёл диалог школы на «человека»');
});

test('Атака 3 (контроль): подпись секретом своего приложения — принимается (контроль)', async () => {
  const r = await post(customerTo(IG_EDU, 'peer-ok-3', 'Привіт'), SECRET_EDU);
  assert.equal(r.status, 200);
  assert.ok(db.prepare('SELECT 1 FROM bot_dialogs WHERE peer_id = ?').get('peer-ok-3'));
});

test('Атака 4 (контроль): IDOR — диалог школы не открывается и не отвечается из проекта академии', async () => {
  const d = db.prepare('SELECT * FROM bot_dialogs WHERE peer_id = ?').get('peer-real-2');
  assert.equal(dialogs.openDialog(d.id, edu), null);
  await assert.rejects(() => dialogs.humanReply(d.id, edu, 1, 'hi'), /не найден/);
  await assert.rejects(() => dialogs.retryLead(d.id, edu), /не найден/);
  assert.throws(() => dialogs.returnToBot(d.id, edu), /не найден/);
});

test('Атака 5 (контроль): echo без подписи / с подписью от другого тела — 401', async () => {
  const raw = Buffer.from(JSON.stringify(echoFrom(IG_EDU, 'peer-ok-3', 'x')));
  const r1 = await fetch(`${base}/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  const r2 = await fetch(`${base}/webhooks/meta`, { method: 'POST', headers: { 'x-hub-signature-256': sign(Buffer.from('{}'), SECRET_EDU) }, body: raw });
  assert.deepEqual([r1.status, r2.status], [401, 401]);
});


test('С1: одно приложение на все проекты — его секрет открывает их все; META_APP_SECRET — только явным списком', () => {
  const raw = Buffer.from('{}');
  const sig = sign(raw, SECRET_EDU);
  const signer = signatureValid(raw, sig, dialogs.appSecrets());
  assert.deepEqual([...signer.projectIds], [edu]);
  // Школа переходит на то же приложение — секрет общий.
  projects.saveAccount(school, 'facebook', { pageId: '100000000000002', pageToken: 't', appSecret: SECRET_EDU }, { quiet: true });
  try {
    assert.deepEqual([...signatureValid(raw, sig, dialogs.appSecrets()).projectIds].sort(), [edu, school].sort());
  } finally {
    projects.saveAccount(school, 'facebook', { pageId: '100000000000002', pageToken: 't', appSecret: SECRET_SCHOOL }, { quiet: true });
  }
  process.env.META_APP_SECRET = 'env-secret';
  try {
    const envSig = sign(raw, 'env-secret');
    assert.equal(signatureValid(raw, envSig, dialogs.appSecrets()), null, 'без списка проектов секрет из окружения ни за кого не говорит');
    process.env.META_APP_SECRET_PROJECTS = 'school';
    assert.deepEqual([...signatureValid(raw, envSig, dialogs.appSecrets()).projectIds], [school]);
  } finally {
    delete process.env.META_APP_SECRET;
    delete process.env.META_APP_SECRET_PROJECTS;
  }
});

function fakeReqRes({ method = 'POST', headers = {} }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method, get: (k) => h[k.toLowerCase()] };
  const res = { code: 0, status(c) { this.code = c; return this; }, json() { return this; } };
  return { req, res };
}

test('Г1: изменения в боте — только со страницы панели', () => {
  const run = (o) => {
    const { req, res } = fakeReqRes(o);
    let passed = false;
    sameOriginOnly(req, res, () => (passed = true));
    return passed ? 'ok' : res.code;
  };
  const host = 'smm.mycomputer.education';
  assert.equal(run({ headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin' } }), 'ok');
  assert.equal(run({ headers: { host, origin: 'https://python.mycomputer.education', 'sec-fetch-site': 'same-site' } }), 403);
  assert.equal(run({ headers: { host, origin: 'https://python.mycomputer.education' } }), 403);
  assert.equal(run({ headers: { host: '127.0.0.1:3210', 'x-forwarded-host': host, origin: `https://${host}` } }), 'ok');
  assert.equal(run({ method: 'GET', headers: { host, origin: 'https://evil.test' } }), 'ok');
  assert.equal(run({ headers: { host } }), 'ok'); // не браузер — cookie у него нет
});

test('Г2: ответы вебхука — nosniff и CSP, challenge только безопасный', async () => {
  const token = knowledge.settings(edu).verifyToken;
  let r = await fetch(`${base}/webhooks/meta?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=%3Cscript%3E`);
  assert.equal(r.status, 400);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  r = await fetch(`${base}/webhooks/meta?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/plain/);
  assert.equal(await r.text(), '1158201444');
  r = await fetch(`${base}/webhooks/meta?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=${'1'.repeat(300)}`);
  assert.equal(r.status, 400);
});

test('Г3: адрес CRM только https, смена адреса сбрасывает ключи', async () => {
  leadsSettings.applyLeadsSettings({ url: 'https://mycomputer.education', token: 'a', feedToken: 'b', leadsWriteToken: 'c' });
  assert.throws(() => leadsSettings.applyLeadsSettings({ url: 'http://evil.test' }), /https/);
  assert.throws(() => leadsSettings.applyLeadsSettings({ url: 'http://127.0.0.1:3318' }), /https/);
  assert.ok(staff.getSetting('crm_leads_write_token', ''), 'отказ не трогает ключи');
  // Тот же адрес — ключи на месте.
  assert.deepEqual(leadsSettings.applyLeadsSettings({ url: 'https://mycomputer.education/' }).reset, []);
  const out = leadsSettings.applyLeadsSettings({ url: 'https://other.test' });
  assert.deepEqual(out.reset.sort(), ['crm_feed_token', 'crm_leads_write_token', 'leads_api_token']);
  for (const k of leadsSettings.LEADS_KEYS) assert.equal(staff.getSetting(k, ''), '');
  // Новый ключ тем же запросом — сохраняется.
  leadsSettings.applyLeadsSettings({ url: 'https://third.test', leadsWriteToken: 'd' });
  assert.ok(staff.getSetting('crm_leads_write_token', ''));
  // Стенд: http на localhost только с ALLOW_HTTP_CRM=1.
  process.env.ALLOW_HTTP_CRM = '1';
  try {
    assert.equal(leadsSettings.leadsUrlAllowed('http://127.0.0.1:3318'), true);
    assert.equal(leadsSettings.leadsUrlAllowed('http://evil.test'), false);
  } finally {
    delete process.env.ALLOW_HTTP_CRM;
  }
  // Ключ по http не уходит, даже если адрес попал в базу в обход формы.
  staff.setSetting('leads_api_url', 'http://evil.test');
  staff.setSetting('crm_leads_write_token', encrypt('tok'));
  const r = await crm.createLead({ channel: 'direct', phone: '+380671234567' });
  assert.equal(r.status, 'no_access');
});
