/**
 * Находки тестировщика 19.10.2026 — каждая закрыта проверкой.
 *
 * Агент `feature-qa` прогнал фичу живьём и нашёл места, где бот вёл себя не
 * так, как обещает `docs/бот.md`. Тесты названы по сути поломки, чтобы при
 * падении было видно, какая именно вернулась.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-bot-qa-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const projects = await import('../src/projects.js');
const knowledge = await import('../src/bot/knowledge.js');
const materials = await import('../src/bot/materials.js');
const { matchStop, decide } = await import('../src/bot/match.js');
const { SCORE, LIMITS } = await import('../src/bot/specs.js');

let alpha;
let beta;

before(() => {
  alpha = projects.createProject({ slug: 'qa-alpha', title: 'Академия' }).id;
  beta = projects.createProject({ slug: 'qa-beta', title: 'Школа дизайна' }).id;
});

/* ------------------------------ стоп-темы ------------------------------ */

test('жалобы ловятся в тех формах, какими их пишут', () => {
  // Зацепка «скарг» не ловила «скаржусь», «жалоб» — «жаловаться»: бот
  // отвечал на жалобу автоматически.
  for (const q of ['скаржусь на якість занять', 'буду жаловаться', 'хочу пожаловаться на викладача', 'это мошенничество']) {
    assert.equal(matchStop(q)?.id, 'complaint', `пропущено: ${q}`);
  }
});

test('оплата ловится в живых формах, включая наличные и переводы', () => {
  for (const q of ['куда переводить деньги', 'приймаєте готівку?', 'можна оплатити частинами', 'куди переказати на карту']) {
    assert.equal(matchStop(q)?.id, 'money', `пропущено: ${q}`);
  }
});

test('вопрос о преподавателе — стоп-тема, даже когда слова стоят врозь', () => {
  assert.equal(matchStop('хто у вас викладач')?.id, 'staff');
  assert.equal(matchStop('скажіть прізвище вчителя')?.id, 'staff');
});

test('безобидные сообщения про картинки и карту не глушатся', () => {
  // Фраза «на карті» проверялась «по словам врозь», предлог «на» есть везде,
  // а «карті» цепляло «картинки» — молчали на четырёх живых вопросах.
  for (const q of ['скиньте картинки на вайбер', 'де ви на карті?', 'на завтра є картинки курсу?', 'покажіть на карті де філія']) {
    assert.equal(matchStop(q), null, `ложное срабатывание: ${q}`);
  }
});

test('стоп-слово возвращается наружу — без него ложное срабатывание не поймать', () => {
  const res = decide('куди переказати на карту', []);
  assert.equal(res.decision, 'stop');
  assert.ok(res.stop.trigger, 'экран проверки показывает, какое слово сработало');
});

/* -------------------------------- подбор -------------------------------- */

test('зацепка из одного общего слова даёт черновик, а не ответ клиенту', () => {
  const kb = [{ id: 1, topic: '', question: 'Який розклад занять?', answer: 'Двічі на тиждень.', triggers: 'коли заняття', lang: 'any', channel: 'any', priority: 0 }];
  for (const q of ['курс валют який у вас', 'ваші заняття нудні', 'я вже купила курс в іншій школі']) {
    const res = decide(q, kb);
    assert.equal(res.decision, 'draft', `${q} → ${res.decision} ${res.score}`);
    assert.ok(res.score < SCORE.CONFIDENT);
  }
});

test('точная зацепка по-прежнему отвечает сама', () => {
  const kb = [{ id: 1, topic: '', question: 'Ціна', answer: '3800 грн', triggers: 'ціна\nскільки коштує', lang: 'any', channel: 'any', priority: 0 }];
  assert.equal(decide('ціна?', kb).decision, 'answer');
  assert.equal(decide('скільки коштує навчання?', kb).decision, 'answer');
});

test('слабая зацепка называется владельцу словами', () => {
  const weak = knowledge.weakTriggers({ triggers: 'коли заняття\nскільки коштує' });
  assert.deepEqual(weak, ['коли заняття']);
});

/* ------------------------------ режимы бота ------------------------------ */

test('в режиме черновиков клиенту не уходит даже текст «ответа нет»', () => {
  knowledge.create(alpha, { question: 'Ціна', answer: '3800 грн', triggers: 'ціна' });
  knowledge.saveSettings(alpha, { enabled: true, autoReply: false, fallbackText: 'Уточню і повернусь.' });
  const res = knowledge.tryQuestion(alpha, 'чи можна з котом?');
  assert.equal(res.willSend, null, 'черновики значат, что бот не пишет клиенту ничего');
  knowledge.saveSettings(alpha, { autoReply: true });
});

test('канал должен быть хотя бы один, и только известный', () => {
  assert.throws(() => knowledge.saveSettings(alpha, { channels: ['telegram'] }), /Канала/);
  assert.throws(() => knowledge.saveSettings(alpha, { channels: [] }), /хотя бы один канал/);
});

test('свои стоп-слова ограничены по размеру', () => {
  assert.throws(() => knowledge.saveSettings(alpha, { stopExtra: 'слово\n'.repeat(500) }), /стоп-слов больше/);
});

test('зацепка из одного знака не принимается', () => {
  assert.throws(() => knowledge.create(alpha, { question: 'В', answer: 'О', triggers: 'а' }), /минимум две буквы/);
  assert.throws(() => knowledge.create(alpha, { question: 'В', answer: 'О', triggers: '???' }), /минимум две буквы/);
});

/* ---------------------------- чужие проекты ---------------------------- */

test('запись чужого проекта не правится и не архивируется по id', () => {
  const mine = knowledge.create(alpha, { question: 'Моя запись', answer: 'мой ответ', triggers: 'моя зацепка' });
  assert.throws(() => knowledge.update(mine.id, { answer: 'подмена' }, beta), /не найдена/);
  assert.throws(() => knowledge.setArchived(mine.id, true, beta), /не найдена/);
  assert.equal(knowledge.get(mine.id).answer, 'мой ответ');
  assert.equal(knowledge.get(mine.id, beta), null, 'для чужого проекта её просто нет');
});

test('блок материалов чужого проекта не читается по id', () => {
  const block = materials.create(alpha, { title: 'Мой блок', body: 'текст' });
  assert.equal(materials.get(block.id, beta), null);
  assert.throws(() => materials.toAnswer(block.id, beta), /не найден/);
});

/* ------------------------------- материалы ------------------------------- */

test('длинный блок превращается в ответ, а не в тупик', () => {
  const long = ('Перше речення тут. ' + 'Ще одне речення про курс. '.repeat(60)).trim();
  assert.ok(long.length > LIMITS.answerMax);
  const block = materials.create(alpha, { title: 'Довгий блок', body: long });
  const draft = materials.toAnswer(block.id, alpha);
  assert.ok(draft.shortened, 'владельцу сказано, что текст сокращён');
  assert.ok(draft.answer.length <= LIMITS.answerMax, `${draft.answer.length} символов`);
  // Обрезка по границе предложения, а не по середине слова.
  assert.match(draft.answer, /[.!?]$/);
  knowledge.create(alpha, { question: draft.question, answer: draft.answer, triggers: draft.triggers });
});

test('ключ блока привязан к сайту: два сайта с одинаковым ключом не затирают друг друга', () => {
  const one = { materials: [{ section: 'prices', sourceKey: 'content:pricing:0', title: 'Тариф сайта А', body: 'А' }] };
  const two = { materials: [{ section: 'prices', sourceKey: 'content:pricing:0', title: 'Тариф сайта Б', body: 'Б' }] };
  materials.applyCollected(beta, one, 'https://alpha.test');
  materials.applyCollected(beta, two, 'https://beta.test');
  const titles = materials.list(beta).map((m) => m.title);
  assert.ok(titles.includes('Тариф сайта А'));
  assert.ok(titles.includes('Тариф сайта Б'));
});

test('блоки, собранные до привязки к сайту, не заводятся заново', () => {
  const legacy = { materials: [{ section: 'faq', sourceKey: 'content:faq:7', title: 'Старый', body: 'текст' }] };
  materials.applyCollected(alpha, legacy); // без сайта — как было до правки
  const again = materials.applyCollected(alpha, legacy, 'https://alpha.test');
  assert.equal(again.added, 0, 'старый блок узнан по прежнему ключу');
});

test('рубрика «без рубрики» фильтруется отдельно от «всех»', () => {
  knowledge.create(alpha, { topic: '', question: 'Без рубрики', answer: 'о', triggers: 'без рубрики тут' });
  knowledge.create(alpha, { topic: 'ціни', question: 'З рубрикою', answer: 'о', triggers: 'з рубрикою тут' });
  const none = knowledge.list(alpha, { topic: '__none__' });
  assert.ok(none.length >= 1);
  assert.ok(none.every((e) => !e.topic));
});
