/**
 * Ручные действия с отправленным (queue/manual.js), 13.09.2026.
 *
 * Каждый случай — дыра, найденная разбором флоу Telegram:
 *   — повтор после трёх неудач молча ничего не делал;
 *   — «неизвестно, ушёл ли» висело навсегда;
 *   — снятый из сети пост не должен выйти снова при следующем повторе.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-manual-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const manual = await import('../src/queue/manual.js');
const { dueQuery } = await import('../src/queue/recover.js');

before(() => {
  db.exec("INSERT INTO projects (slug, title, position) VALUES ('m', 'Тест', 99)");
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // занято — подчистит система
  }
});

function makePost(status = 'published') {
  return Number(
    db
      .prepare(
        `INSERT INTO posts (title, body, status, scheduled_at, project_id)
         VALUES ('тест', 'текст', ?, datetime('now', '-5 minutes'), 1)`
      )
      .run(status).lastInsertRowid
  );
}

function makeTarget(postId, { platform = 'telegram', status = 'published', externalId = null, attempts = 0, parts = null } = {}) {
  return Number(
    db
      .prepare(
        `INSERT INTO post_targets (post_id, platform, format_id, status, external_id, attempts, parts)
         VALUES (?, ?, 'any', ?, ?, ?, ?)`
      )
      .run(postId, platform, status, externalId, attempts, parts).lastInsertRowid
  );
}

const targetOf = (id) => db.prepare('SELECT * FROM post_targets WHERE id = ?').get(id);
const postOf = (id) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id);

test('повтор сбрасывает счётчик попыток у не ушедших, вышедшее не трогает', () => {
  const postId = makePost('failed');
  const failed = makeTarget(postId, { status: 'failed', attempts: 3 });
  const done = makeTarget(postId, { platform: 'threads', status: 'published', attempts: 1 });
  manual.resetForRetry(postId);
  assert.equal(targetOf(failed).status, 'pending');
  assert.equal(targetOf(failed).attempts, 0);
  assert.equal(targetOf(done).status, 'published');
  assert.equal(targetOf(done).attempts, 1);
});

test('«пост там есть» — цель вышла, пост целиком опубликован', () => {
  const postId = makePost('partial');
  const t = makeTarget(postId, { status: 'needs_check' });
  makeTarget(postId, { platform: 'threads', status: 'published' });
  assert.equal(manual.resolveUnknown(postId, t, 'published'), 'published');
  assert.equal(targetOf(t).status, 'published');
  assert.equal(postOf(postId).status, 'published');
});

test('«поста нет» — цель на повтор, и воркер пост подхватит', () => {
  const postId = makePost('partial');
  const t = makeTarget(postId, { status: 'needs_check', attempts: 3 });
  makeTarget(postId, { platform: 'threads', status: 'published' });
  assert.equal(manual.resolveUnknown(postId, t, 'retry'), 'partial');
  assert.equal(targetOf(t).status, 'pending');
  assert.equal(targetOf(t).attempts, 0);
  const due = db.prepare(dueQuery()).all().map((r) => r.id);
  assert.ok(due.includes(postId), 'пост должен попасть в выборку воркера');
});

test('разобрать можно только то, что ждёт проверки', () => {
  const postId = makePost();
  const t = makeTarget(postId, { status: 'published' });
  assert.throws(() => manual.resolveUnknown(postId, t, 'retry'), (e) => e.status === 422);
});

test('снятие: зовёт remove с id, цель становится removed, пост остаётся вышедшим', async () => {
  const postId = makePost();
  const t = makeTarget(postId, { externalId: '12,13' });
  const calls = [];
  const adapterFor = () => ({ remove: async (id, creds) => calls.push([id, creds]) });
  const status = await manual.unpublishTarget(postId, t, { adapterFor, credsFor: () => ({ token: 'x' }) });
  assert.deepEqual(calls, [['12,13', { token: 'x' }]]);
  assert.equal(targetOf(t).status, 'removed');
  assert.equal(status, 'published');
});

test('снятая цель не уходит повтором', async () => {
  const { publishPost } = await import('../src/queue/publish.js');
  const postId = makePost('partial');
  const removed = makeTarget(postId, { status: 'removed', externalId: '5' });
  // Площадку без доступов повтор честно отметит упавшей — но снятую не тронет.
  const result = await publishPost(postId);
  assert.equal(targetOf(removed).status, 'removed');
  assert.ok(result.results.some((r) => r.skipped === 'снят из сети'));
  assert.equal(postOf(postId).status, 'published');
});

test('отказ площадки при снятии — ошибка, цель остаётся вышедшей', async () => {
  const postId = makePost();
  const t = makeTarget(postId, { externalId: '9' });
  const adapterFor = () => ({
    remove: async () => {
      throw new Error("message can't be deleted");
    },
  });
  await assert.rejects(() => manual.unpublishTarget(postId, t, { adapterFor, credsFor: () => ({}) }), /can't be deleted/);
  assert.equal(targetOf(t).status, 'published');
});

test('серия сторис: упал второй кадр — первый вычеркнут, повтор начнёт со второго', async () => {
  const postId = makePost();
  const parts = JSON.stringify([
    { media_id: 1, external_id: 'a' },
    { media_id: 2, external_id: 'b' },
  ]);
  const t = makeTarget(postId, { platform: 'instagram', parts });
  let fail = true;
  const removed = [];
  const adapterFor = () => ({
    remove: async (id) => {
      if (id === 'b' && fail) throw new Error('сбой');
      removed.push(id);
    },
  });
  await assert.rejects(() => manual.unpublishTarget(postId, t, { adapterFor, credsFor: () => ({}) }), /осталось 1/);
  assert.deepEqual(JSON.parse(targetOf(t).parts).map((p) => p.external_id), ['b']);

  fail = false;
  await manual.unpublishTarget(postId, t, { adapterFor, credsFor: () => ({}) });
  assert.deepEqual(removed, ['a', 'b']);
  assert.equal(targetOf(t).status, 'removed');
});

test('без id или без remove у площадки — понятная ошибка, а не «снято»', async () => {
  const postId = makePost();
  const noId = makeTarget(postId, { externalId: null });
  await assert.rejects(
    () => manual.unpublishTarget(postId, noId, { adapterFor: () => ({ remove: async () => {} }), credsFor: () => ({}) }),
    /не вернула id/
  );
  const tiktok = makeTarget(postId, { platform: 'tiktok', externalId: 'p1' });
  await assert.rejects(() => manual.unpublishTarget(postId, tiktok, { adapterFor: () => ({}), credsFor: () => ({}) }), /руками/);
});

test('сводный статус после ручных действий', () => {
  const s = (...statuses) => manual.statusAfterManual(statuses.map((status) => ({ status })));
  assert.equal(s('published', 'removed'), 'published');
  assert.equal(s('pending'), 'scheduled');
  assert.equal(s('published', 'pending'), 'partial');
  assert.equal(s('published', 'needs_check'), 'partial');
  assert.equal(s('failed'), 'failed');
});

test('правка вышедшего: адаптер получает текст и настройки, новые id сохраняются', async () => {
  const postId = makePost();
  const t = makeTarget(postId, { externalId: '20,21' });
  db.prepare('UPDATE post_targets SET options = ? WHERE id = ?').run('{"pin":true,"button":{"text":"Так","url":"https://example.com/x"}}', t);
  let seen;
  const adapterFor = () => ({
    edit: async (id, payload) => {
      seen = { id, ...payload };
      return { externalId: '20' };
    },
  });
  await manual.editTarget(postId, t, { adapterFor, credsFor: () => ({}) });
  assert.equal(seen.id, '20,21');
  assert.ok(seen.text.startsWith('текст'), 'текст поста — с подписью проекта, как при публикации');
  assert.equal(seen.options.pin, true);
  assert.equal(seen.options.button.url, 'https://example.com/x', 'чужая ссылка кнопки не подменяется');
  assert.equal(targetOf(t).external_id, '20');
});

test('правка не вышедшего или у площадки без edit — отказ', async () => {
  const postId = makePost('scheduled');
  const pending = makeTarget(postId, { status: 'pending' });
  await assert.rejects(() => manual.editTarget(postId, pending, { adapterFor: () => ({ edit: async () => ({}) }), credsFor: () => ({}) }), /только вышедший/);
  const live = makeTarget(postId, { platform: 'threads', externalId: '1' });
  await assert.rejects(() => manual.editTarget(postId, live, { adapterFor: () => ({}), credsFor: () => ({}) }), /не даёт править/);
});
