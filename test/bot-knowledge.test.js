/**
 * База знаний бота: правка, архив, настройки и ответ «что уйдёт клиенту».
 *
 * Отдельно от подбора: там проверяется понятливость, здесь — что ничего не
 * пропадает и что бот молчит, пока ему не разрешили говорить.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-bot-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const projects = await import('../src/projects.js');
const knowledge = await import('../src/bot/knowledge.js');
const { LIMITS } = await import('../src/bot/specs.js');

let projectId;

before(() => {
  projectId = projects.createProject({ slug: 'bot', title: 'Бот' }).id;
});

const sample = (over = {}) => ({
  topic: 'ціни',
  question: 'Скільки коштує навчання',
  answer: '3800 грн на місяць, у групі до 6 осіб.',
  triggers: 'скільки коштує\nціна\nсколько стоит',
  ...over,
});

test('запись создаётся, зацепки чистятся от пустых строк', () => {
  const entry = knowledge.create(projectId, sample({ triggers: 'ціна\n\n  скільки коштує  \n;\n' }));
  assert.equal(entry.question, 'Скільки коштує навчання');
  assert.equal(entry.triggers, 'ціна\nскільки коштує');
  assert.equal(entry.triggerCount, 2);
  assert.equal(entry.active, true);
});

test('без ответа запись не заводится', () => {
  assert.throws(() => knowledge.create(projectId, sample({ answer: '  ' })), /Без ответа/);
  assert.throws(() => knowledge.create(projectId, sample({ question: '' })), /Без вопроса/);
});

test('ответ длиннее предела Direct отбивается при сохранении, а не при отправке', () => {
  assert.throws(
    () => knowledge.create(projectId, sample({ answer: 'я'.repeat(LIMITS.answerMax + 1) })),
    /Direct его обрежет/
  );
});

test('«удаление» — архив, и запись возвращается', () => {
  const entry = knowledge.create(projectId, sample({ question: 'Куда уходит' }));
  knowledge.setArchived(entry.id, true);

  assert.ok(!knowledge.list(projectId).some((e) => e.id === entry.id), 'из рабочего списка ушла');
  assert.ok(knowledge.list(projectId, { archived: true }).some((e) => e.id === entry.id), 'в архиве нашлась');
  assert.ok(!knowledge.liveEntries(projectId).some((e) => e.id === entry.id), 'бот ею не отвечает');

  knowledge.setArchived(entry.id, false);
  assert.ok(knowledge.list(projectId).some((e) => e.id === entry.id), 'вернулась в работу');
});

test('выключенной записью бот не отвечает, но из списка она не исчезает', () => {
  const entry = knowledge.create(projectId, sample({ question: 'Выключенный', triggers: 'незвичайне слово' }));
  knowledge.update(entry.id, { active: false });

  assert.ok(knowledge.list(projectId).some((e) => e.id === entry.id));
  assert.ok(!knowledge.liveEntries(projectId).some((e) => e.id === entry.id));

  const res = knowledge.tryQuestion(projectId, 'незвичайне слово');
  assert.notEqual(res.entry?.id, entry.id);
});

test('настройки создаются сами и бот по умолчанию выключен', () => {
  const fresh = projects.createProject({ slug: 'bot2', title: 'Бот 2' }).id;
  const cfg = knowledge.settings(fresh);
  assert.equal(cfg.enabled, false, 'новый проект не начинает отвечать клиентам сам собой');
  assert.equal(cfg.autoReply, true);
  assert.deepEqual(cfg.channels, ['direct', 'messenger', 'comments']);
});

test('выключенный бот ничего не отправит, хотя ответ подобран', () => {
  knowledge.create(projectId, sample({ question: 'Ціна основна' }));
  const res = knowledge.tryQuestion(projectId, 'скільки коштує?');
  assert.equal(res.decision, 'answer');
  assert.equal(res.willSend, null, 'пока бот выключен, клиенту не уходит ничего');
});

test('включённый бот отправляет ровно текст записи', () => {
  knowledge.saveSettings(projectId, { enabled: true });
  const res = knowledge.tryQuestion(projectId, 'скільки коштує?');
  assert.equal(res.willSend, res.entry.answer);
  assert.match(res.willSend, /3800/);
});

test('режим черновиков отключает отправку, не меняя подбор', () => {
  knowledge.saveSettings(projectId, { enabled: true, autoReply: false });
  const res = knowledge.tryQuestion(projectId, 'скільки коштує?');
  assert.equal(res.decision, 'answer');
  assert.equal(res.willSend, null);
  knowledge.saveSettings(projectId, { autoReply: true });
});

test('на стоп-теме бот молчит, даже если ответ в базе есть', () => {
  const res = knowledge.tryQuestion(projectId, 'Скільки коштує і куди оплатити?');
  assert.equal(res.decision, 'stop');
  assert.equal(res.willSend, null, 'на жалобу или оплату «передам человеку» не отправляем');
});

test('незнакомый вопрос отдаёт текст «не знаю», если он задан', () => {
  let res = knowledge.tryQuestion(projectId, 'Чи можна приходити з котом?');
  assert.equal(res.decision, 'handoff');
  assert.equal(res.willSend, null, 'пустой текст — значит молчим');

  knowledge.saveSettings(projectId, { fallbackText: 'Уточню і повернусь з відповіддю.' });
  res = knowledge.tryQuestion(projectId, 'Чи можна приходити з котом?');
  assert.equal(res.willSend, 'Уточню і повернусь з відповіддю.');
  knowledge.saveSettings(projectId, { fallbackText: '' });
});

test('свои стоп-слова из настроек работают в подборе', () => {
  knowledge.saveSettings(projectId, { stopExtra: 'конкурент' });
  const res = knowledge.tryQuestion(projectId, 'Чим ви краще за конкурента?');
  assert.equal(res.decision, 'stop');
  knowledge.saveSettings(projectId, { stopExtra: '' });
});

test('счётчик использований растёт и показывает, чем бот живёт', () => {
  const entry = knowledge.create(projectId, sample({ question: 'Счётчик' }));
  knowledge.bump(entry.id);
  knowledge.bump(entry.id);
  const fresh = knowledge.get(entry.id);
  assert.equal(fresh.hits, 2);
  assert.ok(fresh.lastUsedAt, 'видно, когда спрашивали последний раз');
});

test('рубрики считаются по живым записям', () => {
  const topics = knowledge.topics(projectId);
  const prices = topics.find((t) => t.topic === 'ціни');
  assert.ok(prices.total >= 2, 'в рубрике «ціни» несколько записей');
});

test('поиск находит по ответу, а не только по вопросу', () => {
  const found = knowledge.list(projectId, { search: '3800' });
  assert.ok(found.length >= 1, 'цена из текста ответа находится поиском');
});
