/**
 * Проверки Facebook Reels.
 *
 * До 12.09.2026 формат «Reels» в панели был, а видео уходило обычным
 * видеопостом через `/videos` — в раздел Reels не попадало, и заметить это
 * можно было, только открыв страницу. Здесь проверяется, что Reels идут своим
 * API и в своём порядке, а обычное видео — прежним путём.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const facebook = await import('../src/platforms/facebook.js');

const realFetch = globalThis.fetch;
const creds = { pageId: '1128', pageToken: 'page-token' };
const video = { kind: 'video', url: 'https://smm.example/media/smoke-reel.mp4' };
const publicUrl = (m) => m.url;

/**
 * Площадка по сценарию. `statuses` — что отвечать на опрос состояния по очереди.
 */
function fakeGraph({ statuses = [{ uploading_phase: { status: 'complete' } }], uploadFails = false } = {}) {
  const calls = [];
  let poll = 0;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ href, method: init.method || 'GET', body, headers: init.headers || {} });
    const reply = (data, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => data });

    if (href.includes('/video_reels') && body.upload_phase === 'start') {
      return reply({ video_id: 'v77', upload_url: 'https://rupload.facebook.com/video-upload/v77' });
    }
    if (href.includes('rupload.facebook.com')) {
      return uploadFails ? reply({ error: { message: 'file_url недоступен' } }, false) : reply({ success: true });
    }
    if (href.includes('fields=status')) {
      const s = statuses[Math.min(poll, statuses.length - 1)];
      poll += 1;
      return reply({ status: s });
    }
    if (href.includes('/video_reels') && body.upload_phase === 'finish') return reply({ success: true });
    if (href.includes('/videos')) return reply({ id: 'plain-video' });
    return reply({ error: { message: `неожиданный вызов ${href}` } }, false);
  };
  return calls;
}

test('Reels идут через video_reels: start → upload → статус → finish', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeGraph();

  const out = await facebook.publish({ text: 'подпись', media: [video], formatId: 'reels', publicUrl, creds });

  const steps = calls.map((c) =>
    c.href.includes('rupload') ? 'upload' : c.body.upload_phase || (c.href.includes('fields=status') ? 'status' : c.href)
  );
  assert.deepEqual(steps, ['start', 'upload', 'status', 'finish']);
  assert.ok(!calls.some((c) => c.href.includes('/videos')), 'обычный видеопост вызываться не должен');
  assert.equal(out.externalId, 'v77');
});

test('площадке передаётся адрес файла, а не байты', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeGraph();
  await facebook.publish({ text: 'п', media: [video], formatId: 'reels', publicUrl, creds });

  const upload = calls.find((c) => c.href.includes('rupload'));
  assert.equal(upload.headers.file_url, video.url);
  assert.equal(upload.headers.Authorization, 'OAuth page-token');
});

test('finish не зовётся, пока загрузка не завершилась', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeGraph({
    statuses: [
      { uploading_phase: { status: 'in_progress' } },
      { uploading_phase: { status: 'in_progress' } },
      { uploading_phase: { status: 'complete' } },
    ],
  });
  await facebook.publishReel({ text: 'п', video, publicUrl, creds, waitMs: 1 });

  const statusCalls = calls.filter((c) => c.href.includes('fields=status')).length;
  assert.equal(statusCalls, 3);
  assert.equal(calls.at(-1).body.upload_phase, 'finish', 'finish — последним, после готовности');
});

test('отказ площадки в загрузке — ошибка с причиной, без finish', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeGraph({
    statuses: [{ video_status: 'error', uploading_phase: { status: 'error', errors: [{ message: 'неверный кодек' }] } }],
  });

  await assert.rejects(
    () => facebook.publishReel({ text: 'п', video, publicUrl, creds, waitMs: 1 }),
    /неверный кодек/
  );
  assert.ok(!calls.some((c) => c.body.upload_phase === 'finish'));
});

test('Reels без видео — ошибка, а не тихая публикация фото', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  fakeGraph();
  await assert.rejects(
    () => facebook.publish({ text: 'п', media: [{ kind: 'image', url: 'x.jpg' }], formatId: 'reels', publicUrl, creds }),
    /нужен видеофайл/
  );
});

test('обычное видео в ленте по-прежнему идёт через /videos', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeGraph();
  const out = await facebook.publish({ text: 'п', media: [video], formatId: 'feed-square', publicUrl, creds });
  assert.ok(calls.some((c) => c.href.includes('/videos')));
  assert.ok(!calls.some((c) => c.href.includes('video_reels')));
  assert.equal(out.externalId, 'plain-video');
});
