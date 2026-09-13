/**
 * Длина текста в проверке поста — такой, какой он уйдёт (13.09.2026).
 *
 * До этого проверка считала текст до подмены наших ссылок короткими, а
 * короткая `https://smm.mycomputer.education/r/xxxxxxx` длиннее исходной: пост,
 * прошедший проверку, упирался в 500 символов Threads уже при отправке.
 * Telegram длинный текст не отвергает — он уходит несколькими сообщениями, и
 * блокировать его было неправдой.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validatePost } = await import('../src/validate.js');
const { withShortLinks, parseOwnDomains, CODE_LENGTH } = await import('../src/shortlink.js');

const shortLink = { baseUrl: 'https://smm.mycomputer.education', ownDomains: ['mycomputer.education'] };
const post = (body, targets, media = []) => ({ body, media, targets, signature: '' });
const threads = [{ platform: 'threads', format_id: 'square' }];
const telegram = [{ platform: 'telegram', format_id: 'any' }];

test('наша ссылка считается короткой, чужая и пунктуация — как есть', () => {
  const text = 'Сайт: https://mycomputer.education. Партнёр: https://example.com/a';
  const out = withShortLinks(text, shortLink);
  assert.equal(out, `Сайт: https://smm.mycomputer.education/r/${'x'.repeat(CODE_LENGTH)}. Партнёр: https://example.com/a`);
  assert.deepEqual(parseOwnDomains(' a.ua, b.ua ,,'), ['a.ua', 'b.ua']);
});

test('Threads: пост, влезающий до подмены ссылок, но не после, — отказ', () => {
  const body = `${'а'.repeat(470)} https://mycomputer.education`; // 499 символов написано
  assert.equal(validatePost(post(body, threads)).ok, true, 'без контекста — по написанному');
  const v = validatePost(post(body, threads), { shortLink });
  assert.equal(v.ok, false);
  assert.match(v.blockers[0].message, /с учётом коротких ссылок/);
});

test('Telegram: длинный текст — предупреждение с числом сообщений, не отказ', () => {
  const body = 'слово '.repeat(1000); // ~6000 символов
  const v = validatePost(post(body, telegram), { shortLink });
  assert.equal(v.ok, true);
  assert.match(v.warnings.map((w) => w.message).join('\n'), /2 сообщениями/);

  const short = validatePost(post('коротко', telegram), { shortLink });
  assert.equal(short.warnings.length, 0);
});

test('подпись проекта входит в длину', () => {
  const v = validatePost({ body: 'а'.repeat(450), media: [], targets: threads, signature: 'б'.repeat(60) });
  assert.equal(v.ok, false);
});

test('Telegram: фото с суммой сторон больше 10000 или вытянутое сильнее 1:20 — отказ', () => {
  const photo = (w, h) => ({ id: 1, kind: 'image', mime: 'image/jpeg', bytes: 1000, width: w, height: h, original_name: 'a.jpg' });
  const huge = validatePost(post('x', telegram, [photo(6000, 5000)]));
  assert.match(huge.blockers.map((b) => b.message).join(), /сумма сторон/);
  const strip = validatePost(post('x', telegram, [photo(4200, 200)]));
  assert.match(strip.blockers.map((b) => b.message).join(), /1:20/);
  assert.equal(validatePost(post('x', telegram, [photo(1080, 1920)])).ok, true);
});

test('Telegram: большой файл больше не пугает «по ссылке до 5 МБ»', () => {
  const photo = { id: 1, kind: 'image', mime: 'image/jpeg', bytes: 8 * 1024 * 1024, width: 2000, height: 2000, original_name: 'a.jpg' };
  const v = validatePost(post('x', telegram, [photo]));
  assert.equal(v.warnings.length, 0);
});
