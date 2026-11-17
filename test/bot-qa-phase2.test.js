/**
 * Находки тестировщика по фазе 2 бота (17.11.2026). На каждую — проверка,
 * которая падала до правки. Meta и админка — заглушками, данные выдуманные.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'smm-bot2qa-'));
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
const { matchStop } = await import('../src/bot/match.js');
const { parseAges, chooseReply, STEP } = await import('../src/bot/funnel.js');
const { mountMetaWebhook } = await import('../src/bot/webhook.js');
const express = (await import('express')).default;

const IG = '17840000000000009';
const SECRET = 'qa-app-secret';
let projectId;
const outbox = [];
let seq = 0;
let n = 0;

async function plainSender(m) {
  n += 1;
  outbox.push({ ...m, mid: `m_qa_${n}` });
  return { mid: `m_qa_${n}` };
}

before(() => {
  projectId = projects.getProjectBySlug('education').id;
  projects.saveAccount(projectId, 'instagram', { userId: IG, pageToken: 'tok' }, { quiet: true });
  projects.saveAccount(projectId, 'facebook', { pageId: '100000000000009', pageToken: 'tok', appSecret: SECRET }, { quiet: true });
  knowledge.saveSettings(projectId, { enabled: true, autoReply: true });
});

beforeEach(() => {
  db.prepare("UPDATE bot_reply_plans SET status = 'cancelled' WHERE status IN ('pending', 'sending')").run();
  db.prepare('UPDATE bot_dialogs SET reminders_sent = 2').run();
  outbox.length = 0;
  send.setSender(plainSender);
  crm.setFetch(null);
});

const nowIso = () => new Date().toISOString();
function customer(peer, text, ts = Date.now()) {
  seq += 1;
  return { object: 'instagram', entry: [{ id: IG, time: ts, messaging: [{ sender: { id: peer }, recipient: { id: IG }, timestamp: ts, message: { mid: `m_qa_in_${seq}`, text } }] }] };
}
function echo(peer, mid, text, ts = Date.now()) {
  return { object: 'instagram', entry: [{ id: IG, time: ts, messaging: [{ sender: { id: IG }, recipient: { id: peer }, timestamp: ts, message: { mid, text, is_echo: true } }] }] };
}
const dialogOf = (peer) => db.prepare('SELECT * FROM bot_dialogs WHERE peer_id = ?').get(peer);
const later = (sec) => new Date(Date.now() + sec * 1000);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

/* 1. Ранний echo у черновика и у ответа из панели. */

test('1: черновик + ранний echo — диалог остаётся у бота, сообщение одно', async () => {
  knowledge.saveSettings(projectId, { autoReply: false });
  try {
    dialogs.ingest(customer('q1', 'Вітаю'));
    assert.deepEqual(await dialogs.runDue({ now: later(11) }), ['draft']);
    const d = dialogOf('q1');
    send.setSender(async (m) => {
      dialogs.ingest(echo('q1', 'm_q1_early', m.text));
      return { mid: 'm_q1_early' };
    });
    const out = await dialogs.sendDraft(d.id, projectId, 1);
    assert.equal(out.dialog.handledBy, 'bot');
    const outs = db.prepare("SELECT source FROM bot_messages WHERE dialog_id = ? AND direction = 'out'").all(d.id);
    assert.deepEqual(outs.map((r) => r.source), ['bot']);
  } finally {
    knowledge.saveSettings(projectId, { autoReply: true });
  }
});

test('1: ответ из панели + ранний echo — одно сообщение человека, mid записан', async () => {
  dialogs.ingest(customer('q2', 'Вітаю'));
  const d = dialogOf('q2');
  send.setSender(async (m) => {
    dialogs.ingest(echo('q2', 'm_q2_early', m.text));
    return { mid: 'm_q2_early' };
  });
  await dialogs.humanReply(d.id, projectId, 7, 'Добрий день, це адміністратор');
  const outs = db.prepare("SELECT source, mid FROM bot_messages WHERE dialog_id = ? AND direction = 'out'").all(d.id);
  assert.deepEqual(outs.map((r) => ({ ...r })), [{ source: 'human', mid: 'm_q2_early' }]);
  assert.equal(db.prepare('SELECT source FROM bot_sent_mids WHERE mid = ?').get('m_q2_early').source, 'human');
});

/* 2. Три параллельных «Повторить заявку» — одна заявка. */

test('2: три параллельных повтора заявки — в CRM одна, остальным 409', async () => {
  dialogs.ingest(customer('q3', 'Вітаю'));
  const d = dialogOf('q3');
  db.prepare("UPDATE bot_dialogs SET phone = '+380671234567', contact_name = 'Ліна', lead_status = 'failed' WHERE id = ?").run(d.id);
  staff.setSetting('leads_api_url', 'https://crm.test');
  staff.setSetting('crm_leads_write_token', encrypt('tok-manager'));
  const gate = deferred();
  let calls = 0;
  crm.setFetch(async () => {
    calls += 1;
    await gate.promise;
    return new Response('{"lead":{"id":1}}', { status: 201 });
  });
  const runs = [1, 2, 3].map(() => dialogs.retryLead(d.id, projectId));
  setTimeout(gate.resolve, 20);
  const res = await Promise.allSettled(runs);
  assert.equal(calls, 1);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(res.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 409));
  await assert.rejects(dialogs.retryLead(d.id, projectId), (e) => e.status === 409);
});

/* 3. Двойная отправка с двух вкладок. */

test('3: черновик с двух вкладок — клиенту одно сообщение', async () => {
  knowledge.saveSettings(projectId, { autoReply: false });
  try {
    dialogs.ingest(customer('q4', 'Вітаю'));
    await dialogs.runDue({ now: later(11) });
    const d = dialogOf('q4');
    const gate = deferred();
    send.setSender(async (m) => {
      await gate.promise;
      return plainSender(m);
    });
    const a = dialogs.sendDraft(d.id, projectId, 1);
    const b = dialogs.sendDraft(d.id, projectId, 2);
    setTimeout(gate.resolve, 20);
    const res = await Promise.allSettled([a, b]);
    assert.equal(outbox.length, 1);
    assert.equal(res.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 1);
  } finally {
    knowledge.saveSettings(projectId, { autoReply: true });
  }
});

test('3: ответ из панели с двух вкладок — одно сообщение, повтор через секунду тоже 409', async () => {
  dialogs.ingest(customer('q5', 'Вітаю'));
  const d = dialogOf('q5');
  const gate = deferred();
  send.setSender(async (m) => {
    await gate.promise;
    return plainSender(m);
  });
  const a = dialogs.humanReply(d.id, projectId, 1, 'Добрий день!');
  const b = dialogs.humanReply(d.id, projectId, 2, 'Добрий день!');
  setTimeout(gate.resolve, 20);
  const res = await Promise.allSettled([a, b]);
  assert.equal(outbox.length, 1);
  assert.equal(res.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 1);
  await assert.rejects(dialogs.humanReply(d.id, projectId, 1, 'Добрий день!'), (e) => e.status === 409);
});

/* 4. Стоп-темы: возврат денег и «куда кидать». */

test('4: стоп-темы ловят возврат и переводы, не ловят соседние слова', () => {
  for (const t of ['поверніть гроші', 'верните деньги', 'хочу повернути кошти', 'скільки на приват кидати', 'на яку картку скинути?']) {
    assert.ok(matchStop(t), t);
  }
  for (const t of ['хочу повернутись на заняття', 'приватні заняття є?', 'на приватне заняття', 'скиньте картинки на вайбер']) {
    assert.equal(matchStop(t), null, t);
  }
});

/* 5. Ложное «двое детей». */

test('5: второе число — возраст только с возрастным словом или союзом', () => {
  assert.deepEqual(parseAges('синові 7 років, 1 клас'), [7]);
  assert.deepEqual(parseAges('у нас 3 питання, дитині 7'), [7]);
  assert.deepEqual(parseAges('дитині 7, ходить у 2-й клас'), [7]);
  assert.deepEqual(parseAges('7 і 12'), [7, 12]);
  assert.deepEqual(parseAges('7 та 12 років'), [7, 12]);
  assert.deepEqual(parseAges('У мене двоє, 7 і 12 років'), [7, 12]);
  const r = chooseReply({ dialog: { step: STEP.askAge, tags: '' }, text: 'синові 7 років, 1 клас', say: (k) => k, entries: [], settings: {} });
  assert.equal(r.replyKey, 'age_6_9');
});

/* 6. Запоздавшее событие. */

test('6: запоздавшее событие не двигает last_customer_at назад', () => {
  const t = Date.now();
  dialogs.ingest(customer('q6', 'друге', t));
  dialogs.ingest(customer('q6', 'перше, запізніле', t - 60 * 60 * 1000));
  assert.equal(dialogOf('q6').last_customer_at, new Date(t).toISOString());
  assert.equal(dialogOf('q6').last_message_at, new Date(t).toISOString());
});

/* 7. Messenger — своя метка заявки. */

test('7: заявка из Messenger — fb_dm и facebook', () => {
  const b = crm.leadBody({ channel: 'messenger', phone: '+380501112233', contact_name: 'Ія' });
  assert.equal(b.source, 'fb_dm');
  assert.equal(b.utm_source, 'facebook');
  assert.equal(crm.leadBody({ channel: 'direct', phone: '1' }).source, 'ig_dm');
});

/* 8. «Вернуть боту» помнит возраст. */

test('8: после «вернуть боту» возраст восстанавливается из переписки', async () => {
  dialogs.ingest(customer('q7', 'Вітаю'));
  const d = dialogOf('q7');
  dialogs.ingest(echo('q7', 'm_q7_phone', 'Добрий день! Скільки років дитині?'));
  dialogs.ingest(customer('q7', 'сину 9'));
  assert.equal(dialogOf('q7').handled_by, 'human');
  const back = dialogs.returnToBot(d.id, projectId);
  assert.equal(back.dialog.childAge, 9);
  dialogs.ingest(customer('q7', 'так'));
  assert.deepEqual(await dialogs.runDue({ now: later(11) }), ['sent']);
  assert.match(outbox[0].text, /^9 років — чудовий вік/);
});

/* 9. «Пізніше» / «не треба» на напоминание. */

test('9: «не треба» — прощание, «пізніше» — человеку, текст напоминания ничего не обещает', () => {
  const say = (k) => k;
  const no = chooseReply({ dialog: { step: STEP.trial, tags: '', reminders_sent: 2 }, text: 'не треба', say, entries: [], settings: {} });
  assert.equal(no.replyKey, 'goodbye');
  assert.equal(no.patch.step, STEP.done);
  const notNo = chooseReply({ dialog: { step: STEP.trial, tags: '', child_age: 8 }, text: 'а компʼютер не треба?', say, entries: [], settings: {} });
  assert.notEqual(notNo.replyKey, 'goodbye');
  const lat = chooseReply({ dialog: { step: STEP.trial, tags: '', reminders_sent: 2 }, text: 'пізніше', say, entries: [], settings: {} });
  assert.equal(lat.text, null);
  assert.equal(lat.handoff, 'просил напомнить позже');
  const remind = replies.text(projectId, 'remind_24h', 'uk');
  assert.doesNotMatch(remind, /Нагадаю згодом/);
  assert.ok(replies.list(projectId).find((r) => r.key === 'remind_24h').draft);
  assert.ok(replies.text(projectId, 'goodbye', 'ru'));
});

/* 10. Суржик о цене. */

test('10: «скіко стоїть», «скока» — вопрос о цене', () => {
  const say = (k) => k;
  for (const t of ['скіко стоїть?', 'скока', 'а скоко це']) {
    const r = chooseReply({ dialog: { step: STEP.askAge, tags: '' }, text: t, say, entries: [], settings: {} });
    assert.equal(r.replyKey, 'price_then_age', t);
  }
});

/* 11. Слишком большое тело. */

test('11: тело больше 1 МБ — 413', async () => {
  const app = express();
  mountMetaWebhook(app);
  // Как в src/server.js: всё, что не разобрано маршрутом, общий обработчик отдаёт 500.
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const raw = JSON.stringify({ object: 'instagram', pad: 'x'.repeat(1.2 * 1024 * 1024) });
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
    const r = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/meta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
      body: raw,
    });
    assert.equal(r.status, 413);
  } finally {
    server.close();
  }
});

/* 13. Ребёнок пишет сам — данных не берём. */

test('13: пишет ребёнок — возраст не записывается', async () => {
  const r = chooseReply({ dialog: { step: STEP.start, tags: '' }, text: 'привіт, мені 11, хочу робити ігри', say: (k) => k, entries: [], settings: {} });
  assert.equal(r.replyKey, 'child_trial');
  assert.equal('child_age' in r.patch, false);
  dialogs.ingest(customer('q8', 'привіт, мені 11, хочу робити ігри'));
  await dialogs.runDue({ now: later(11) });
  assert.equal(dialogOf('q8').child_age, null);
  // И «вернуть боту» его не достаёт из переписки.
  assert.equal(dialogs.returnToBot(dialogOf('q8').id, projectId).dialog.childAge, null);
});

/* Застрявшее «в полёте». */

test('план, застрявший в sending, — без двойной отправки', async () => {
  dialogs.ingest(customer('q9', 'Вітаю'));
  dialogs.ingest(customer('q10', 'Вітаю'));
  const a = dialogOf('q9');
  const b = dialogOf('q10');
  const old = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  // q9: ответ уже ушёл (echo записан), но статус не обновился.
  db.prepare("UPDATE bot_reply_plans SET status = 'sending', text = 'Вітаємо!', updated_at = ?, created_at = ? WHERE dialog_id = ? AND status = 'pending'").run(old, old, a.id);
  db.prepare("INSERT INTO bot_messages (dialog_id, direction, mid, text, source, sent_at) VALUES (?, 'out', 'm_q9', 'Вітаємо!', 'bot', ?)").run(a.id, nowIso());
  // q10: упал до отправки.
  db.prepare("UPDATE bot_reply_plans SET status = 'sending', text = 'Вітаємо!', updated_at = ? WHERE dialog_id = ? AND status = 'pending'").run(old, b.id);
  // Свежий «sending» не трогается.
  assert.equal(dialogs.recoverStuck({ now: new Date(Date.now() - 4 * 60 * 1000) }), 0);
  assert.equal(dialogs.recoverStuck(), 2);
  const st = (d) => db.prepare('SELECT status FROM bot_reply_plans WHERE dialog_id = ? ORDER BY id DESC').get(d.id).status;
  assert.equal(st(a), 'sent');
  assert.equal(st(b), 'pending');
  assert.deepEqual(await dialogs.runDue({ now: later(11) }), ['sent']);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].peerId, 'q10');
});

/* Школа дизайна: тексты академии не уходят. */

test('школа дизайна: без своих возрастных текстов — человеку, не Scratch/Minecraft', () => {
  const school = projects.getProjectBySlug('school').id;
  const keys = new Set(replies.list(school).map((r) => r.key));
  assert.equal(keys.has('age_6_9'), false);
  assert.equal(keys.has('offline'), false);
  assert.equal(keys.has('ask_age'), true);
  const say = (k, v = {}) => replies.text(school, k, v.lang || 'uk', v);
  const r = chooseReply({ dialog: { step: STEP.askAge, tags: '' }, text: 'доньці 8', say, entries: [], settings: {} });
  assert.equal(r.text, null);
  assert.match(r.handoff, /нет реплики/);
  // У FluentFox нет и цен академии.
  const ff = projects.getProjectBySlug('fluentfox').id;
  assert.equal(new Set(replies.list(ff).map((x) => x.key)).has('price_then_age'), false);
});
