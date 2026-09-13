/**
 * Проверки публикации в Threads.
 *
 * 13.09.2026 первая проба картинки упала: `threads_publish` вызывался, пока
 * площадка ещё скачивала файл, и отвечал «The requested resource does not
 * exist». Здесь проверяется, что публикация ждёт готовности контейнера, а
 * отказ площадки доходит с причиной.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const threads = await import('../src/platforms/threads.js');

const realFetch = globalThis.fetch;
const creds = { userId: '29062313960036757', accessToken: 'token' };
const publicUrl = (m) => m.url;

function fakeThreads({ statuses = ['FINISHED'], errorMessage = null } = {}) {
  const calls = [];
  let seq = 0;
  let poll = 0;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ href, body });
    const reply = (data) => ({ ok: true, status: 200, json: async () => data });

    if (href.endsWith('/threads_publish')) return reply({ id: 'published-1' });
    if (href.endsWith('/threads')) return reply({ id: `c${++seq}` });
    if (href.includes('fields=status')) {
      const status = statuses[Math.min(poll, statuses.length - 1)];
      poll += 1;
      return reply({ status, error_message: status === 'ERROR' ? errorMessage : undefined });
    }
    return reply({ error: { message: `неожиданный вызов ${href}` } });
  };
  return calls;
}

const steps = (calls) =>
  calls.map((c) => (c.href.endsWith('/threads_publish') ? 'publish' : c.href.includes('fields=status') ? 'status' : 'create'));

test('картинка публикуется только после готовности контейнера', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeThreads({ statuses: ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'] });

  await threads.publish({ text: 'т', media: [{ kind: 'image', url: 'a.jpg' }], publicUrl, creds, pauseMs: 1 });

  assert.deepEqual(steps(calls), ['create', 'status', 'status', 'status', 'publish']);
});

test('текст публикуется сразу — скачивать площадке нечего', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeThreads();
  await threads.publish({ text: 'т', media: [], publicUrl, creds });
  assert.deepEqual(steps(calls), ['create', 'publish']);
});

test('карусель ждёт каждый кадр и саму карусель', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeThreads();
  await threads.publish({
    text: 'т',
    media: [{ kind: 'image', url: 'a.jpg' }, { kind: 'image', url: 'b.jpg' }],
    publicUrl,
    creds,
    pauseMs: 1,
  });
  assert.deepEqual(steps(calls), ['create', 'status', 'create', 'status', 'create', 'status', 'publish']);
});

test('отказ площадки в сборке — ошибка с причиной, без публикации', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeThreads({ statuses: ['ERROR'], errorMessage: 'Media download has failed' });
  await assert.rejects(
    () => threads.publish({ text: 'т', media: [{ kind: 'image', url: 'a.jpg' }], publicUrl, creds, pauseMs: 1 }),
    /Media download has failed/
  );
  assert.ok(!calls.some((c) => c.href.endsWith('/threads_publish')));
});
