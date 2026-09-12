/**
 * Проверки удаления опубликованного.
 *
 * Удаление опаснее публикации ошибиться молча: «удалили» при неудаче значит,
 * что тестовый пост остался висеть в живом аккаунте школы, а мы уверены в
 * обратном. Поэтому здесь проверяется ровно одно — отказ площадки обязан
 * дойти до вызывающего ошибкой, а не превратиться в тихий успех.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const facebook = await import('../src/platforms/facebook.js');
const instagram = await import('../src/platforms/instagram.js');
const threads = await import('../src/platforms/threads.js');

const realFetch = globalThis.fetch;

function answer({ status = 200, body = {} } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return { ok: status < 400, status, json: async () => body };
  };
  return calls;
}

test('удаление уходит методом DELETE, а не GET', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const calls = answer({ body: { success: true } });
  await facebook.remove('123_456', { pageToken: 'p' });
  await instagram.remove('17900', { pageToken: 'p' });
  await threads.remove('9001', { accessToken: 'a' });

  assert.deepEqual(calls.map((c) => c.method), ['DELETE', 'DELETE', 'DELETE']);
  assert.ok(calls[0].url.includes('/123_456'));
  assert.ok(calls[2].url.includes('graph.threads'), 'Threads живёт на своём хосте, не на graph.facebook.com');
});

test('отказ по правам — это ошибка, а не «удалено»', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  // Так отвечает Meta, когда у токена нет pages_manage_posts: код 200 по
  // HTTP, ошибка внутри тела. Проверять только res.ok здесь недостаточно.
  answer({ status: 200, body: { error: { message: '(#200) Permissions error' } } });
  await assert.rejects(() => facebook.remove('1_2', { pageToken: 'p' }), /Permissions error/);

  answer({ status: 200, body: { error: { message: 'instagram_manage_contents required' } } });
  await assert.rejects(() => instagram.remove('1', { pageToken: 'p' }), /instagram_manage_contents/);

  answer({ status: 400, body: { error: { message: 'threads_delete required' } } });
  await assert.rejects(() => threads.remove('1', { accessToken: 'a' }), /threads_delete/);
});

test('Threads возвращает id удалённого — по нему и сверяемся', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  answer({ body: { success: true, deleted_id: '9001' } });

  const res = await threads.remove('9001', { accessToken: 'a' });
  assert.equal(res.ok, true);
  assert.equal(res.deletedId, '9001');
});
