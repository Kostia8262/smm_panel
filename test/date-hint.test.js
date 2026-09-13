/**
 * Подсказка под временем публикации.
 *
 * Фраза «пост уйдёт при первой же проверке очереди» была одна на всё и врала
 * дважды: опубликованному посту (он уже ушёл) и черновику (в очереди его нет).
 * Найдено 12.09.2026, исправлено 13.09.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pastHint } = await import('../public/js/datetime.js');

test('опубликованному посту не обещаем, что он «уйдёт»', () => {
  const h = pastHint('published', true);
  assert.equal(h.text, 'Пост опубликован.');
  assert.doesNotMatch(h.text, /уйдёт/);
});

test('черновик с прошедшим временем сам не уходит — так и говорим', () => {
  const h = pastHint('draft', true);
  assert.match(h.text, /черновик сам не уйдёт/);
  assert.doesNotMatch(h.text, /при первой же проверке очереди/);
});

test('пост в очереди с прошедшим временем уйдёт при первой проверке', () => {
  assert.match(pastHint('scheduled', true).text, /при первой же проверке очереди/);
});

test('частичная и неудачная публикация зовут к повтору, а не к ожиданию', () => {
  assert.match(pastHint('partial', true).text, /Повторить неудачные/);
  assert.equal(pastHint('failed', false).tone, 'danger');
});

test('будущее время у черновика и очереди — обычный отсчёт', () => {
  assert.equal(pastHint('draft', false), null);
  assert.equal(pastHint('scheduled', false), null);
});
