/**
 * Проверки обязательной подписи.
 *
 * Опасность подписи не в ней самой, а в том, что она невидимо съедает лимит:
 * пост на 450 знаков проходит в Threads, а с подписью в 80 — уже нет. Если
 * счётчик считает без неё, человек узнаёт об этом от площадки.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-sign-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { withSignature, signatureFor } = await import('../src/signature.js');
const { validatePost } = await import('../src/validate.js');

const SIGN = 'Комп\'ютерна академія\nЗапис: https://mycomputer.education\nТел: +38 (095) 462-46-72';

test('подпись приклеивается через разделитель', () => {
  const out = withSignature('Текст поста', SIGN);
  assert.ok(out.startsWith('Текст поста'));
  assert.ok(out.includes('mycomputer.education'));
  assert.ok(out.includes('\n—\n'), 'между текстом и подписью нужен разделитель');
});

test('пустая подпись ничего не меняет', () => {
  assert.equal(withSignature('Текст', ''), 'Текст');
  assert.equal(withSignature('Текст', null), 'Текст');
});

test('подпись не дублируется, если автор вписал её сам', () => {
  const manual = `Текст поста\n\n${SIGN}`;
  assert.equal(withSignature(manual, SIGN), manual.trimEnd());
});

test('лишние переносы не превращаются в дубль', () => {
  const manual = `Текст\n\n\nКомп'ютерна академія\n\nЗапис:  https://mycomputer.education\nТел:  +38 (095) 462-46-72`;
  const out = withSignature(manual, SIGN);
  const hits = out.split('mycomputer.education').length - 1;
  assert.equal(hits, 1, 'адрес сайта должен встречаться один раз');
});

test('подпись учитывается в лимите Threads', () => {
  const body = 'я'.repeat(450);
  const targets = [{ platform: 'threads', format_id: 'square' }];

  const without = validatePost({ body, media: [], targets, signature: '' });
  assert.equal(without.ok, true, '450 знаков без подписи в Threads влезают');

  const withSign = validatePost({ body, media: [], targets, signature: SIGN });
  assert.equal(withSign.ok, false, 'с подписью те же 450 знаков уже не влезают');
  assert.ok(withSign.blockers.some((b) => /длиннее лимита/.test(b.message)));
});

test('снятая у поста подпись не применяется', () => {
  const project = { signature: SIGN, signatureEnabled: true };
  assert.equal(signatureFor({ skip_signature: 1 }, project), '');
  assert.equal(signatureFor({ skip_signature: 0 }, project), SIGN);
});

test('выключенная у проекта подпись не применяется никому', () => {
  const project = { signature: SIGN, signatureEnabled: false };
  assert.equal(signatureFor({ skip_signature: 0 }, project), '');
});

test('у поста без текста остаётся только подпись, без пустого разделителя', () => {
  const out = withSignature('', SIGN);
  assert.equal(out, SIGN);
  assert.ok(!out.startsWith('—'));
});
