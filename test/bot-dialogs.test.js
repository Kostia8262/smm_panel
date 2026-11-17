/**
 * Переписка бота: вебхук Meta, план с задержкой, склейка очереди, echo,
 * окно 24 часа, черновики, «вернуть боту», заявка в CRM.
 *
 * Meta здесь нет вовсе: отправка подменена заглушкой (`setSender`), админка
 * школы — подменённым `fetch`. Аккаунты, id и тексты выдуманные.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'smm-bot2-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');
process.env.NODE_ENV = 'test';

const { db } = await import('../src/db.js');
const projects = await import('../src/projects.js');
const knowledge = await import('../src/bot/knowledge.js');
const dialogs = await import('../src/bot/dialogs.js');
const replies = await import('../src/bot/replies.js');
const send = await import('../src/bot/send.js');
const crm = await import('../src/bot/crm-lead.js');
const staff = await import('../src/staff.js');
const { encrypt } = await import('../src/secrets.js');
const { signatureValid, verifyTokenValid, mountMetaWebhook } = await import('../src/bot/webhook.js');
const express = (await import('express')).default;

const IG = '17840000000000001';
const PAGE = '100000000000001';
const SECRET = 'test-app-secret';
let projectId;
const outbox = [];
let failNext = null;

before(() => {
  projectId = projects.createProject({ slug: 'acad', title: 'Академія' }).id;
  projects.saveAccount(projectId, 'instagram', { userId: IG, pageToken: 'tok-ig' }, { quiet: true });
  projects.saveAccount(projectId, 'facebook', { pageId: PAGE, pageToken: 'tok-fb', appSecret: SECRET }, { quiet: true });
  knowledge.saveSettings(projectId, { enabled: true, autoReply: true });
  send.setSender(defaultSender);
});

let n = 0;
async function defaultSender(m) {
  {
    if (failNext) {
      const e = failNext;
      failNext = null;
      throw e;
    }
    n += 1;
    const mid = `m_bot_${n}`;
    outbox.push({ ...m, mid });
    return { mid };
  }
}

beforeEach(() => {
  // Каждая проверка — со своими диалогами: чужие планы не должны созревать.
  db.prepare("UPDATE bot_reply_plans SET status = 'cancelled' WHERE status = 'pending'").run();
  db.prepare("UPDATE bot_dialogs SET reminders_sent = 2").run();
  outbox.length = 0;
  crm.setFetch(null);
});

let seq = 0;
const T0 = Date.parse('2026-11-17T10:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000);

function customer(peer, text, sec, object = 'instagram') {
  seq += 1;
  return {
    object,
    entry: [{
      id: object === 'instagram' ? IG : PAGE,
      time: T0 + sec * 1000,
      messaging: [{ sender: { id: peer }, recipient: { id: object === 'instagram' ? IG : PAGE }, timestamp: T0 + sec * 1000, message: { mid: `m_in_${seq}`, text } }],
    }],
  };
}

function echo(peer, mid, text, sec) {
  return {
    object: 'instagram',
    entry: [{ id: IG, time: T0 + sec * 1000, messaging: [{ sender: { id: IG }, recipient: { id: peer }, timestamp: T0 + sec * 1000, message: { mid, text, is_echo: true } }] }],
  };
}

const dialogOf = (peer) => db.prepare('SELECT * FROM bot_dialogs WHERE peer_id = ?').get(peer);
const plansOf = (d) => db.prepare('SELECT * FROM bot_reply_plans WHERE dialog_id = ? ORDER BY id').all(d.id);

test('подпись: верная проходит, чужая и пустая — нет', () => {
  const raw = Buffer.from('{"object":"instagram"}');
  const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
  assert.equal(signatureValid(raw, sig, [SECRET]), true);
  assert.equal(signatureValid(raw, sig, ['другой']), false);
  assert.equal(signatureValid(Buffer.from('{"object":"page"}'), sig, [SECRET]), false);
  assert.equal(signatureValid(raw, '', [SECRET]), false);
  assert.equal(signatureValid(raw, 'sha256=zz', [SECRET]), false);
});

test('Verify Token выпускается сам и сверяется', () => {
  const token = knowledge.settings(projectId).verifyToken;
  assert.match(token, /^mcbot_/);
  assert.equal(verifyTokenValid(token), true);
  assert.equal(verifyTokenValid('чужой'), false);
  assert.equal(verifyTokenValid(''), false);
});

test('сообщение клиента: диалог, план через 10 секунд, ответ — шаг 1', async () => {
  dialogs.ingest(customer('p1', 'Вітаю', 0), { now: at(0) });
  const d = dialogOf('p1');
  assert.equal(d.handled_by, 'bot');
  assert.equal(d.unread, 1);
  const [plan] = plansOf(d);
  assert.equal(plan.status, 'pending');
  assert.equal(plan.send_at, at(10).toISOString());

  assert.deepEqual(await dialogs.runDue({ now: at(5) }), []); // рано
  assert.deepEqual(await dialogs.runDue({ now: at(10) }), ['sent']);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].text, replies.text(projectId, 'ask_age', 'uk'));
  const after = dialogOf('p1');
  assert.equal(after.step, 'ask_age');
  assert.ok(db.prepare('SELECT 1 FROM bot_sent_mids WHERE mid = ?').get('m_bot_1'));
});

test('повтор доставки того же mid — без дублей', () => {
  const body = customer('p2', 'Добрий день', 0);
  dialogs.ingest(body, { now: at(0) });
  const again = dialogs.ingest(body, { now: at(1) });
  assert.equal(again.duplicates, 1);
  const d = dialogOf('p2');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bot_messages WHERE dialog_id = ?').get(d.id).n, 1);
});

test('очередь из трёх сообщений — один ответ на всю очередь', async () => {
  dialogs.ingest(customer('p3', 'Вітаю', 0), { now: at(0) });
  dialogs.ingest(customer('p3', 'скільки коштує', 4), { now: at(4) });
  dialogs.ingest(customer('p3', 'дитині 8', 8), { now: at(8) });
  const d = dialogOf('p3');
  assert.equal(plansOf(d).length, 1);
  assert.equal(plansOf(d)[0].send_at, at(18).toISOString());
  assert.deepEqual(await dialogs.runDue({ now: at(12) }), []);
  assert.deepEqual(await dialogs.runDue({ now: at(18) }), ['sent']);
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].text, /^8 років — чудовий вік/);
  assert.equal(dialogOf('p3').child_age, 8);
  assert.equal(dialogOf('p3').step, 'trial');
});

test('echo нашего mid — не человек; echo с чужим mid — диалог за человеком', async () => {
  dialogs.ingest(customer('p4', 'Вітаю', 0), { now: at(0) });
  await dialogs.runDue({ now: at(10) });
  const mid = outbox[0].mid;
  dialogs.ingest(echo('p4', mid, outbox[0].text, 11), { now: at(11) });
  assert.equal(dialogOf('p4').handled_by, 'bot');

  dialogs.ingest(customer('p4', '9', 20), { now: at(20) });
  dialogs.ingest(echo('p4', 'm_phone_1', 'Добрий день, це адміністратор', 22), { now: at(22) });
  const d = dialogOf('p4');
  assert.equal(d.handled_by, 'human');
  assert.ok(d.human_at);
  assert.equal(plansOf(d).at(-1).status, 'cancelled');
  assert.deepEqual(await dialogs.runDue({ now: at(40) }), []);
  assert.equal(outbox.length, 1); // бот больше не пишет

  // И на новые вопросы клиента — тоже.
  dialogs.ingest(customer('p4', 'а скільки коштує?', 60), { now: at(60) });
  assert.deepEqual(await dialogs.runDue({ now: at(80) }), []);
});

test('ранний echo (раньше, чем Send API вернул mid) — тоже наш', async () => {
  dialogs.ingest(customer('p5', 'Вітаю', 0), { now: at(0) });
  const d = dialogOf('p5');
  send.setSender(async (m) => {
    // Meta успела прислать echo до ответа Send API.
    dialogs.ingest(echo('p5', 'm_early', m.text, 10), { now: at(10) });
    return { mid: 'm_early' };
  });
  try {
    assert.deepEqual(await dialogs.runDue({ now: at(10) }), ['sent']);
  } finally {
    send.setSender(defaultSender);
  }
  assert.equal(dialogOf('p5').handled_by, 'bot');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bot_messages WHERE dialog_id = ? AND direction = 'out'").get(d.id).n, 1);
});

test('окно 24 часа: вне окна бот не пишет, диалог ждёт человека', async () => {
  dialogs.ingest(customer('p6', 'Вітаю', 0), { now: at(0) });
  // Воркер лежал сутки.
  assert.deepEqual(await dialogs.runDue({ now: at(24 * 3600 + 5) }), ['skipped']);
  assert.equal(outbox.length, 0);
  assert.match(dialogOf('p6').attention, /окно 24 часа/);
});

test('стоп-тема: молча человеку', async () => {
  dialogs.ingest(customer('p7', 'Хочу поскаржитись на викладача', 0), { now: at(0) });
  assert.deepEqual(await dialogs.runDue({ now: at(10) }), ['handoff']);
  assert.equal(outbox.length, 0);
  const d = dialogOf('p7');
  assert.equal(d.handled_by, 'human');
  assert.match(d.attention, /стоп-тема/);
});

test('русский клиент — ответ по-русски', async () => {
  dialogs.ingest(customer('p8', 'Здравствуйте! Сыну 8 лет', 0), { now: at(0) });
  await dialogs.runDue({ now: at(10) });
  assert.match(outbox[0].text, /^8 лет — отличный возраст/);
  assert.equal(dialogOf('p8').lang, 'ru');
});

test('вся воронка до заявки в CRM с источником ig_dm', async () => {
  staff.setSetting('leads_api_url', 'https://crm.test');
  staff.setSetting('crm_leads_write_token', encrypt('tok-manager'));
  const calls = [];
  crm.setFetch(async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ success: true, lead: { id: 501 } }), { status: 201 });
  });
  dialogs.ingest(customer('p9', 'Вітаю, доньці 10', 0), { now: at(0) });
  await dialogs.runDue({ now: at(10) });
  dialogs.ingest(customer('p9', 'так', 30), { now: at(30) });
  await dialogs.runDue({ now: at(40) });
  dialogs.ingest(customer('p9', 'Софія, 067 123 45 67, субота зранку', 60), { now: at(60) });
  await dialogs.runDue({ now: at(70) });
  assert.equal(outbox.length, 3);
  assert.equal(outbox[2].text, replies.text(projectId, 'contacts_thanks', 'uk'));
  const d = dialogOf('p9');
  assert.equal(d.handled_by, 'human');
  assert.equal(d.lead_status, 'sent');
  assert.equal(d.lead_id, '501');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://crm.test/api/leads/admin');
  assert.equal(calls[0].headers['x-admin-token'], 'tok-manager');
  assert.equal(calls[0].body.source, 'ig_dm');
  assert.equal(calls[0].body.child_name, 'Софія');
  assert.equal(calls[0].body.age, 10);
  assert.equal(calls[0].body.phone, '+380671234567');
});

test('ключ интеграции mcai_ идёт на предложенный маршрут с x-integration-key', async () => {
  staff.setSetting('crm_leads_write_token', encrypt('mcai_abc'));
  let seen;
  crm.setFetch(async (url, opts) => {
    seen = { url, headers: opts.headers };
    return new Response('{"id":7}', { status: 201 });
  });
  const r = await crm.createLead({ channel: 'direct', phone: '+380671234567', contact_name: 'Ія', child_age: 7, tags: '' });
  assert.equal(r.status, 'sent');
  assert.equal(seen.url, 'https://crm.test/api/integration/leads');
  assert.equal(seen.headers['x-integration-key'], 'mcai_abc');
  // «Ія» короче двух букв не бывает, а пустое имя заменяется заглушкой.
  assert.equal(crm.leadBody({ channel: 'direct', phone: '1' }).child_name, 'Без імені (Direct)');
});

test('режим «только черновики»: ответ готов, уходит одной кнопкой', async () => {
  knowledge.saveSettings(projectId, { autoReply: false });
  try {
    dialogs.ingest(customer('p10', 'Вітаю', 0), { now: at(0) });
    assert.deepEqual(await dialogs.runDue({ now: at(10) }), ['draft']);
    assert.equal(outbox.length, 0);
    const d = dialogOf('p10');
    assert.equal(d.draft_text, replies.text(projectId, 'ask_age', 'uk'));
    // Окно считается от настоящего времени — сдвинем сообщение клиента в «сейчас».
    db.prepare('UPDATE bot_dialogs SET last_customer_at = ? WHERE id = ?').run(new Date().toISOString(), d.id);
    const out = await dialogs.sendDraft(d.id, projectId, 1);
    assert.equal(outbox.length, 1);
    assert.equal(out.dialog.draftText, null);
    assert.equal(out.dialog.step, 'ask_age');
    assert.equal(out.dialog.handledBy, 'bot');
  } finally {
    knowledge.saveSettings(projectId, { autoReply: true });
  }
});

test('ответ человека из панели и «вернуть боту»', async () => {
  dialogs.ingest(customer('p11', 'Вітаю', 0), { now: at(0) });
  const d = dialogOf('p11');
  db.prepare('UPDATE bot_dialogs SET last_customer_at = ? WHERE id = ?').run(new Date().toISOString(), d.id);
  const out = await dialogs.humanReply(d.id, projectId, 42, 'Добрий день! Це Ольга, адміністратор.');
  assert.equal(out.dialog.handledBy, 'human');
  assert.equal(out.messages.at(-1).source, 'human');
  assert.equal(plansOf(d).at(-1).status, 'cancelled');
  // Echo своего же ответа из панели не путает: он помечен как ответ человека.
  dialogs.ingest(echo('p11', outbox.at(-1).mid, 'Добрий день! Це Ольга, адміністратор.', 30), { now: at(30) });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bot_messages WHERE dialog_id = ? AND source = 'human'").get(d.id).n, 1);

  const back = dialogs.returnToBot(d.id, projectId);
  assert.equal(back.dialog.handledBy, 'bot');
  dialogs.ingest(customer('p11', 'сину 12', 60), { now: new Date() });
  assert.equal(plansOf(d).at(-1).status, 'pending');
});

test('чужой проект диалог не открывает', () => {
  const other = projects.createProject({ slug: 'other', title: 'Інша' }).id;
  const d = dialogOf('p1');
  assert.equal(dialogs.openDialog(d.id, other), null);
});

test('напоминание через 2 часа тишины — одно, в окне', async () => {
  dialogs.ingest(customer('p12', 'Вітаю', 0), { now: at(0) });
  await dialogs.runDue({ now: at(10) });
  const d = dialogOf('p12');
  // Время отправки — настоящее «сейчас»; подвинем отметки в модельное время.
  db.prepare('UPDATE bot_dialogs SET last_bot_at = ? WHERE id = ?').run(at(10).toISOString(), d.id);
  outbox.length = 0;
  assert.deepEqual(await dialogs.runDue({ now: at(3600) }), []);
  assert.deepEqual(await dialogs.runDue({ now: at(2 * 3600 + 10) }), ['sent']);
  assert.equal(outbox[0].text, replies.text(projectId, 'remind_2h', 'uk'));
  assert.equal(dialogOf('p12').reminders_sent, 1);
  db.prepare('UPDATE bot_dialogs SET last_bot_at = ? WHERE id = ?').run(at(2 * 3600 + 10).toISOString(), d.id);
  // Второе — за час до конца окна, а не через сутки после первого.
  assert.deepEqual(await dialogs.runDue({ now: at(22 * 3600) }), []);
  assert.deepEqual(await dialogs.runDue({ now: at(23 * 3600) }), ['sent']);
  assert.equal(dialogOf('p12').reminders_sent, 2);
  assert.deepEqual(await dialogs.runDue({ now: at(23 * 3600 + 1800) }), []);
});

test('сбой Send API — план failed, диалог помечен человеку', async () => {
  dialogs.ingest(customer('p13', 'Вітаю', 0), { now: at(0) });
  failNext = new send.SendError('Send API: (#100) нет доступа');
  assert.deepEqual(await dialogs.runDue({ now: at(10) }), ['failed']);
  assert.match(dialogOf('p13').attention, /не отправился/);
});

test('бот выключен — переписка собирается, ответов нет', async () => {
  knowledge.saveSettings(projectId, { enabled: false });
  try {
    dialogs.ingest(customer('p14', 'Вітаю', 0), { now: at(0) });
    assert.equal(plansOf(dialogOf('p14')).length, 0);
  } finally {
    knowledge.saveSettings(projectId, { enabled: true });
  }
});

test('Messenger узнаётся по id страницы', () => {
  dialogs.ingest(customer('p15', 'Вітаю', 0, 'page'), { now: at(0) });
  assert.equal(dialogOf('p15').channel, 'messenger');
});

test('реплики: черновики из Figma, правка снимает пометку только явно', () => {
  const list = replies.list(projectId);
  assert.ok(list.length >= 40);
  assert.ok(list.every((r) => r.draft));
  const r = list.find((x) => x.key === 'ask_age' && x.lang === 'uk');
  const edited = replies.update(r.id, projectId, { text: 'Вітаємо! Скільки років дитині?' });
  assert.equal(edited.draft, true);
  assert.equal(edited.origin, 'own');
  assert.equal(replies.update(r.id, projectId, { draft: false }).draft, false);
  assert.throws(() => replies.update(r.id, projectId, { text: '  ' }), /Пустая/);
});

test('HTTP: GET-проверка адреса и POST с подписью / без подписи', async () => {
  const app = express();
  mountMetaWebhook(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = knowledge.settings(projectId).verifyToken;
    let r = await fetch(`${base}/webhooks/meta?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '12345');
    r = await fetch(`${base}/webhooks/meta?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1`);
    assert.equal(r.status, 403);

    const raw = JSON.stringify(customer('p16', 'Вітаю', 0));
    r = await fetch(`${base}/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    assert.equal(r.status, 401);
    assert.equal(dialogOf('p16'), undefined);
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
    r = await fetch(`${base}/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
    assert.equal(r.status, 200);
    assert.ok(dialogOf('p16'));
  } finally {
    server.close();
  }
});
