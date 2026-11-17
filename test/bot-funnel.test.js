/**
 * Шаги воронки: распознавание возраста, языка, контактов и выбор реплики.
 * Чистые функции — без базы и сети. Реплики подставляются ключом, чтобы
 * проверять решение, а не текст (текст на вычитке у владельца).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAges, dialogLang, parsePhone, parseName, parsePreferredTime, isFiller, chooseReply, STEP } from '../src/bot/funnel.js';

const say = (key, vars = {}) => `[${key}${vars.age ? ':' + vars.age : ''}|${vars.lang}]`;
const dlg = (over = {}) => ({ step: STEP.start, lang: null, tags: '', reprompted: 0, reminders_sent: 0, child_age: null, ...over });
const run = (text, dialog = dlg(), extra = {}) => chooseReply({ dialog, text, say, entries: [], settings: {}, ...extra });

test('возраст в любом написании', () => {
  assert.deepEqual(parseAges('8'), [8]);
  assert.deepEqual(parseAges('8 років'), [8]);
  assert.deepEqual(parseAges('сину 9'), [9]);
  assert.deepEqual(parseAges('дитині 8.'), [8]);
  assert.deepEqual(parseAges('восемь лет'), [8]);
  assert.deepEqual(parseAges('Доньці 12 років, любить малювати'), [12]);
});

test('время, деньги и телефон — не возраст', () => {
  assert.deepEqual(parseAges('о 18:00'), []);
  assert.deepEqual(parseAges('в 17 можна?'), []);
  assert.deepEqual(parseAges('1900 грн'), []);
  assert.deepEqual(parseAges('0671234567'), []);
  assert.deepEqual(parseAges('2 рази на тиждень'), []);
});

test('язык: русский — ru, суржик и украинский — uk, «8» язык не меняет', () => {
  assert.equal(dialogLang('Здравствуйте, сколько стоит?'), 'ru');
  assert.equal(dialogLang('8 лет'), 'ru');
  assert.equal(dialogLang('Здравствуйте, скільки коштує'), 'uk');
  assert.equal(dialogLang('8', 'ru'), 'ru');
  assert.equal(dialogLang('ок'), 'uk');
});

test('контакты: телефон в разных записях, имя, удобные дни', () => {
  assert.equal(parsePhone('067 123 45 67'), '+380671234567');
  assert.equal(parsePhone('+38 (050) 111-22-33'), '+380501112233');
  assert.equal(parsePhone('дитині 8'), null);
  assert.equal(parseName('Марк, 067 123 45 67, вівторок після 17'), 'Марк');
  assert.equal(parseName('Добрий день! звати Софія +380501112233'), 'Софія');
  assert.equal(parseName('0671234567'), null);
  assert.equal(parsePreferredTime('Марк, 067 123 45 67, вівторок після 17'), 'Марк, вівторок після 17');
  assert.equal(parsePreferredTime('Марк 0671234567'), null);
});

test('пустое: точки, эмодзи, «ок»', () => {
  for (const t of ['...', '👍', 'ок', 'Ок, дякую', '']) assert.equal(isFiller(t), true, t);
  assert.equal(isFiller('ок, а ціна?'), false);
});

test('первое сообщение → шаг 1, вопрос о возрасте', () => {
  const r = run('Вітаю');
  assert.equal(r.replyKey, 'ask_age');
  assert.equal(r.patch.step, STEP.askAge);
  assert.equal(r.handoff, null);
});

test('очередь «Вітаю / скільки коштує / дитині 8» — один ответ по возрасту', () => {
  const r = run('Вітаю\nскільки коштує\nдитині 8');
  assert.equal(r.replyKey, 'age_6_9');
  assert.match(r.text, /\[age_6_9:8\|uk\]\n\n\[step2_common\|uk\]/);
  assert.equal(r.patch.child_age, 8);
  assert.equal(r.patch.step, STEP.trial);
});

test('возрастные ветки', () => {
  assert.equal(run('12', dlg({ step: STEP.askAge })).replyKey, 'age_10_13');
  assert.equal(run('сину 15', dlg({ step: STEP.askAge })).replyKey, 'age_14_18');
  const small = run('їй 4 роки', dlg({ step: STEP.askAge }));
  assert.equal(small.replyKey, 'age_under6');
  assert.equal(small.patch.step, STEP.birthday);
});

test('цену до возраста — отвечаем ценой и спрашиваем возраст', () => {
  const r = run('скільки коштує?', dlg({ step: STEP.askAge }));
  assert.equal(r.replyKey, 'price_then_age');
});

test('согласие на пробное → шаг 3, контакты → заявка и передача человеку', () => {
  const yes = run('так, давайте', dlg({ step: STEP.trial, child_age: 8 }));
  assert.equal(yes.replyKey, 'ask_contacts');
  assert.equal(yes.patch.step, STEP.contacts);
  const c = run('Марк, 0671234567, вівторок після 17', dlg({ step: STEP.contacts, child_age: 8 }));
  assert.equal(c.replyKey, 'contacts_thanks');
  assert.equal(c.lead, true);
  assert.ok(c.handoff);
  assert.equal(c.patch.phone, '+380671234567');
  assert.equal(c.patch.contact_name, 'Марк');
});

test('шаг 3 без телефона — человеку, без выдумывания', () => {
  const r = run('а можна в суботу?', dlg({ step: STEP.contacts }));
  assert.equal(r.text, null);
  assert.ok(r.handoff);
});

test('стоп-тема — молчим и передаём, даже посреди воронки', () => {
  const r = run('куди переказати оплату?', dlg({ step: STEP.trial, child_age: 8 }));
  assert.equal(r.text, null);
  assert.match(r.handoff, /стоп-тема/);
});

test('одно мягкое перепитывание, второе — молчание', () => {
  const first = run('ок', dlg({ step: STEP.askAge }));
  assert.equal(first.replyKey, 'soft_reprompt');
  assert.equal(first.patch.reprompted, 1);
  const second = run('👍', dlg({ step: STEP.askAge, reprompted: 1 }));
  assert.equal(second.text, null);
  assert.equal(second.handoff, null);
});

test('повторное «здравствуйте» — без второго «Вітаємо»', () => {
  assert.equal(run('Здравствуйте', dlg({ step: STEP.askAge })).replyKey, 'second_hello');
});

test('наш клиент: пропуск → короткое подтверждение и человек', () => {
  const r = run('Добрий день, ми сьогодні не зможемо на заняття, син захворів', dlg({ step: STEP.start }));
  assert.equal(r.replyKey, 'client_ack');
  assert.ok(r.handoff);
});

test('пишет сам ребёнок — только зовём родителей', () => {
  const r = run('здрасте а ви вчите робити ігри в роблоксі? мені 11');
  assert.equal(r.replyKey, 'child_trial');
  assert.ok(r.handoff);
  assert.equal(run('а скільки коштує', dlg({ tags: 'child' })).replyKey, 'child_price');
});

test('взрослый «для себе» — передача', () => {
  const r = run('А для дорослих є курси? Хочу сам навчитись');
  assert.equal(r.replyKey, 'adult');
  assert.ok(r.handoff);
});

test('двое детей без слова «знижка» — человеку (условия знает владелец)', () => {
  const r = run('У мене двоє, 7 і 12 років');
  assert.equal(r.text, null);
  assert.ok(r.handoff);
});

test('русский клиент — реплики русские', () => {
  const r = run('Здравствуйте! 8 лет');
  assert.match(r.text, /\|ru\]/);
  assert.equal(r.patch.lang, 'ru');
});

test('за границей и офлайн — свои реплики', () => {
  assert.equal(run('Ми живемо в Німеччині, можна до вас?').replyKey, 'abroad');
  const off = run('А у вас є заняття не онлайн? Ми з Дніпра');
  assert.equal(off.replyKey, 'offline');
  const after = run('10 років', dlg({ step: STEP.askAge, tags: 'offline' }));
  assert.equal(after.replyKey, 'ask_contacts');
});

test('вопрос из базы знаний — ответ и строка про возраст', () => {
  const entries = [{ id: 1, question: 'Чи потрібен компʼютер', answer: 'Потрібен звичайний компʼютер.', triggers: 'потрібен компʼютер', lang: 'uk', channel: 'any', topic: '' }];
  const r = run('а чи потрібен компʼютер?', dlg({ step: STEP.askAge }), { entries });
  assert.equal(r.knowledgeId, 1);
  assert.match(r.text, /^Потрібен звичайний компʼютер\.\n\n\[age_line\|uk\]$/);
});

test('непонятное после шага 1 — человеку, ничего не выдумываем', () => {
  const r = run('у вас є знайомий сантехнік', dlg({ step: STEP.trial, child_age: 9 }));
  assert.equal(r.text, null);
  assert.ok(r.handoff);
});

test('напоминания: первое, второе, третьего нет', () => {
  assert.equal(chooseReply({ dialog: dlg({ step: STEP.trial }), kind: 'remind', say }).replyKey, 'remind_2h');
  assert.equal(chooseReply({ dialog: dlg({ step: STEP.trial, reminders_sent: 1 }), kind: 'remind', say }).replyKey, 'remind_24h');
  assert.equal(chooseReply({ dialog: dlg({ step: STEP.trial, reminders_sent: 2 }), kind: 'remind', say }).text, null);
  assert.equal(chooseReply({ dialog: dlg({ step: STEP.done }), kind: 'remind', say }).text, null);
});
