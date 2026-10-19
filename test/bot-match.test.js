/**
 * Подбор ответа бота.
 *
 * Модели у бота нет (решение владельца 19.10.2026), поэтому вся его
 * понятливость проверяется здесь — на формулировках, какими спрашивают в
 * Direct. Каждый случай в наборе однажды ошибался:
 *   - «Сколько стоит» в украинской записи уходило черновиком из-за языка;
 *   - «Яка погода» цеплялось за «Яка адреса» на половину слов;
 *   - «Чекаю відповіді» считалось стоп-темой из-за «чек» внутри слова;
 *   - «Хто у вас викладач» не считалось стоп-темой: слова стоят врозь.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decide, matchStop, detectLang, hasPhrase } = await import('../src/bot/match.js');
const { tokens, stem } = await import('../src/bot/normalize.js');

const entry = (id, data) => ({
  id,
  topic: '',
  question: '',
  answer: `ответ ${id}`,
  triggers: '',
  lang: 'any',
  channel: 'any',
  priority: 0,
  ...data,
});

const KB = [
  entry(1, {
    topic: 'ціни',
    question: 'Скільки коштує навчання',
    lang: 'uk',
    triggers: 'скільки коштує\nціна\nсколько стоит\nвартість навчання',
  }),
  entry(2, { topic: 'розклад', question: 'Коли проходять заняття', lang: 'uk', triggers: 'розклад\nрасписание' }),
  entry(3, { topic: 'філії', question: 'Де ви знаходитесь', lang: 'uk', triggers: 'де ви знаходитесь\nяка адреса' }),
  entry(4, { topic: 'пробне', question: 'Чи є пробне заняття', lang: 'uk', triggers: 'пробне заняття\nпробний урок' }),
];

test('украинское и русское написание сводятся к одной основе', () => {
  assert.equal(stem('заняття'), stem('занятия'));
  // «Ціна» и «цена» различаются буквой, а не корнем: их держит словарь
  // синонимов, и после него это одно слово.
  assert.deepEqual(tokens('ціна'), tokens('цена'));
  assert.deepEqual(tokens('скільки коштує'), tokens('сколько стоит'));
});

test('точная зацепка отвечает сама и на другом языке', () => {
  const ru = decide('Сколько стоит обучение?', KB);
  assert.equal(ru.decision, 'answer');
  assert.equal(ru.entry.id, 1);
  assert.equal(ru.score, 1);
  assert.equal(detectLang('Сколько стоит обучение?'), 'ru');

  const uk = decide('Добрий день! Скільки коштує курс для дитини?', KB);
  assert.equal(uk.decision, 'answer');
  assert.equal(uk.entry.id, 1);
});

test('вопросительные слова не создают совпадения', () => {
  // «Яка погода» и «Яка адреса» совпадали на половину слов и давали черновик.
  const res = decide('Яка погода?', KB);
  assert.equal(res.decision, 'handoff');
  assert.equal(res.entry, null);
});

test('короткое ключевое слово отвечает, длинная чужая фраза — нет', () => {
  assert.equal(decide('ціна?', KB).entry.id, 1);
  assert.equal(decide('Який у вас розклад на листопад?', KB).entry.id, 2);
  assert.equal(decide('Чи можна приносити свого кота?', KB).decision, 'handoff');
});

test('слова зацепки врозь находят запись', () => {
  const res = decide('а де саме ви знаходитесь?', KB);
  assert.equal(res.entry.id, 3);
  assert.equal(res.decision, 'answer');
});

test('стоп-тема перебивает любой подбор', () => {
  const res = decide('Скільки коштує і чи можна оплатити частинами?', KB);
  assert.equal(res.decision, 'stop');
  assert.equal(res.stop.id, 'money');
  assert.equal(res.entry, null, 'на стоп-теме запись не предлагается даже найденная');
});

test('стоп-фраза ловится, когда её слова стоят врозь', () => {
  assert.equal(matchStop('Хто у вас викладач?').id, 'staff');
  assert.equal(matchStop('Хочу повернути гроші').id, 'money');
  assert.equal(matchStop('Зробіть знижку').id, 'discount');
});

test('граница слова: «чекаю» — не чек, «картинка» — не карта', () => {
  assert.equal(matchStop('Чекаю відповіді'), null);
  assert.equal(matchStop('Надішліть картинку з розкладом'), null);
  assert.equal(hasPhrase('чекаю', 'чек'), false);
  assert.equal(hasPhrase('оплатити', 'оплат'), true);
});

test('свои стоп-слова владельца работают наравне с основой', () => {
  assert.equal(matchStop('А чим ви краще за конкурента?', 'конкурент\nдоговір').id, 'own');
  assert.equal(matchStop('А чим ви краще за конкурента?'), null, 'без настройки это обычный вопрос');
});

test('канал отсеивает записи', () => {
  const kb = [entry(9, { question: 'Під постом', triggers: 'ціна', channel: 'comments' })];
  assert.equal(decide('ціна?', kb, { channel: 'comments' }).entry.id, 9);
  assert.equal(decide('ціна?', kb, { channel: 'direct' }).decision, 'handoff');
});

test('неуверенный подбор уходит черновиком, а не ответом', () => {
  // Совпали два слова зацепки из четырёх: ответ, похоже, тот, но отправлять
  // его без человека нельзя.
  const kb = [entry(5, { question: 'Що потрібно з техніки', triggers: 'чи потрібен ноутбук для занять з програмування' })];
  const res = decide('потрібен ноутбук?', kb);
  assert.equal(res.decision, 'draft');
  assert.ok(res.score > 0.34 && res.score < 0.6, `счёт ${res.score} должен быть между порогами`);
});

test('пустая база знаний всегда зовёт человека', () => {
  const res = decide('Скільки коштує?', []);
  assert.equal(res.decision, 'handoff');
  assert.equal(res.why, 'в базе знаний нет ничего похожего');
});

test('при равном счёте решает приоритет', () => {
  const kb = [
    entry(10, { question: 'Перший', triggers: 'ціна' }),
    entry(11, { question: 'Другий', triggers: 'ціна', priority: 5 }),
  ];
  assert.equal(decide('ціна', kb).entry.id, 11);
});

test('верхние соперники видны для экрана проверки', () => {
  const res = decide('скільки коштує заняття і який розклад', KB);
  assert.ok(res.candidates.length >= 2, 'в проверке должно быть видно, с чем конкурировал ответ');
  assert.ok(res.candidates.every((c) => typeof c.score === 'number'));
});
