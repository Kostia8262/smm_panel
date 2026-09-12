/**
 * Проверки хранения файлов.
 *
 * Ошибиться здесь можно в обе стороны, и обе дорогие:
 *   — снять файл рано: пост, который ещё ждёт своей очереди, уйдёт в сеть
 *     без кадра или не уйдёт вовсе;
 *   — не снять вовсе: файлы копятся на диске, общем с шестнадцатью сайтами.
 *
 * Самый коварный случай — вечнозелёная копия: она ссылается на тот же файл,
 * что и опубликованный оригинал, и снятие по оригиналу стёрло бы кадр у копии.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-retention-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');
process.env.UPLOAD_DIR = join(dir, 'uploads');
process.env.UPLOAD_QUOTA_MB = '1';

const { db } = await import('../src/db.js');
const { verdict, releaseFile, purgePublishedMedia, usedBytes, quotaCheck, RETENTION, MINUTE } = await import(
  '../src/retention.js'
);

let projectId;
let seq = 0;

before(() => {
  projectId = db.prepare("INSERT INTO projects (slug, title, position) VALUES ('keep', 'Хранение', 99)").run()
    .lastInsertRowid;
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // База может быть ещё занята — временный каталог подчистит система.
  }
});

/** Время для базы: `datetime('now')` без зоны, в UTC. */
function ago(ms) {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Пост с одним кадром на диске.
 * @param {{targets?: Array<{status: string, publishedAgo?: number}>, kind?: string, file?: string, deletedAgo?: number}} o
 */
function makePost({ targets = [], kind = 'image', file = null, deletedAgo = null, bytes = 1000 } = {}) {
  seq += 1;
  const name = file || `f${seq}.${kind === 'video' ? 'mp4' : 'jpg'}`;
  if (!existsSync(join(process.env.UPLOAD_DIR, name))) writeFileSync(join(process.env.UPLOAD_DIR, name), 'x');

  const postId = db
    .prepare("INSERT INTO posts (title, body, status, project_id, deleted_at) VALUES ('т', 'т', 'draft', ?, ?)")
    .run(projectId, deletedAgo === null ? null : ago(deletedAgo)).lastInsertRowid;

  targets.forEach((t, i) => {
    db.prepare(
      'INSERT INTO post_targets (post_id, platform, format_id, status, published_at) VALUES (?, ?, ?, ?, ?)'
    ).run(postId, `p${i}`, 'f', t.status, t.publishedAgo === undefined ? null : ago(t.publishedAgo));
  });

  db.prepare(
    `INSERT INTO media (post_id, kind, original_name, stored_name, mime, bytes, position)
     VALUES (?, ?, 'кадр', ?, ?, ?, 0)`
  ).run(postId, kind, name, kind === 'video' ? 'video/mp4' : 'image/jpeg', bytes);

  return { postId, name };
}

const onDisk = (name) => existsSync(join(process.env.UPLOAD_DIR, name));

/* -------------------------------- вердикт -------------------------------- */

test('черновик без целей держит файл', () => {
  const v = verdict([{ kind: 'image', deleted_at: null, targets: [] }]);
  assert.equal(v.keep, true);
});

test('пока хоть одна площадка не приняла пост, файл нужен', () => {
  // Частичная публикация: Instagram упал, и повтор без кадра невозможен.
  const v = verdict([
    {
      kind: 'image',
      deleted_at: null,
      targets: [
        { status: 'published', published_at: ago(5 * 3600 * 1000) },
        { status: 'failed', published_at: null },
      ],
    },
  ]);
  assert.equal(v.keep, true);
});

test('«ждёт ручной проверки» — тоже живой пост', () => {
  const v = verdict([{ kind: 'image', deleted_at: null, targets: [{ status: 'needs_check', published_at: null }] }]);
  assert.equal(v.keep, true);
});

test('опубликованная картинка держится окно, потом отпускается', () => {
  const fresh = verdict([
    { kind: 'image', deleted_at: null, targets: [{ status: 'published', published_at: ago(RETENTION.image / 2) }] },
  ]);
  assert.equal(fresh.keep, true, 'в окне после публикации файл ещё нужен');

  const old = verdict([
    { kind: 'image', deleted_at: null, targets: [{ status: 'published', published_at: ago(RETENTION.image + MINUTE) }] },
  ]);
  assert.equal(old.keep, false);
});

test('видео держится дольше картинки', () => {
  // Facebook отвечает на загрузку видео сразу, а обрабатывает его после:
  // снять файл через десять минут значит сорвать обработку.
  const v = verdict([
    { kind: 'video', deleted_at: null, targets: [{ status: 'published', published_at: ago(RETENTION.image + MINUTE) }] },
  ]);
  assert.equal(v.keep, true);
});

test('окно считается от последней публикации, а не от первой', () => {
  const v = verdict([
    {
      kind: 'image',
      deleted_at: null,
      targets: [
        { status: 'published', published_at: ago(5 * 3600 * 1000) },
        { status: 'published', published_at: ago(RETENTION.image / 2) },
      ],
    },
  ]);
  assert.equal(v.keep, true);
});

/* ------------------------------ файл на диске ------------------------------ */

test('опубликованный пост снимает файл с диска и помечает строку', () => {
  const { name } = makePost({ targets: [{ status: 'published', publishedAgo: RETENTION.image + MINUTE }] });

  purgePublishedMedia();

  assert.equal(onDisk(name), false, 'файл должен уйти с диска');
  const row = db.prepare('SELECT purged_at FROM media WHERE stored_name = ?').get(name);
  assert.ok(row.purged_at, 'строка остаётся в истории с отметкой');
});

test('вечнозелёная копия не даёт стереть общий файл', () => {
  // Оригинал опубликован давно, копия ссылается на тот же файл и ждёт очереди.
  const shared = 'evergreen.jpg';
  makePost({ file: shared, targets: [{ status: 'published', publishedAgo: 5 * 3600 * 1000 }] });
  makePost({ file: shared, targets: [{ status: 'scheduled' }] });

  purgePublishedMedia();

  assert.equal(onDisk(shared), true, 'кадр нужен копии');
  const purged = db.prepare('SELECT COUNT(*) n FROM media WHERE stored_name = ? AND purged_at IS NOT NULL').get(shared).n;
  assert.equal(purged, 0);
});

test('снятие кадра с одного поста не стирает его у копии', () => {
  // Дефект, найденный 12.09.2026: DELETE /api/media/:id удалял файл сразу.
  const shared = 'copy-safe.jpg';
  const original = makePost({ file: shared, targets: [{ status: 'draft' }] });
  makePost({ file: shared, targets: [{ status: 'scheduled' }] });

  db.prepare('DELETE FROM media WHERE post_id = ?').run(original.postId);
  releaseFile(shared);

  assert.equal(onDisk(shared), true);
});

test('последняя ссылка ушла — файл снимается сразу', () => {
  const { postId, name } = makePost({ targets: [{ status: 'draft' }] });
  db.prepare('DELETE FROM media WHERE post_id = ?').run(postId);

  assert.equal(releaseFile(name), true);
  assert.equal(onDisk(name), false);
});

test('удалённый пост отпускает файл после окна', () => {
  const { name } = makePost({ deletedAgo: RETENTION.image + MINUTE, targets: [{ status: 'failed' }] });
  purgePublishedMedia();
  assert.equal(onDisk(name), false);
});

test('живой пост обход не трогает', () => {
  const { name } = makePost({ targets: [{ status: 'scheduled' }] });
  purgePublishedMedia();
  assert.equal(onDisk(name), true);
});

/* --------------------------------- квота --------------------------------- */

test('занятое место считается по файлам, а не по строкам', () => {
  const before = usedBytes();
  // Две строки на один файл — у вечнозелёной копии. На диске он один.
  makePost({ file: 'twice.jpg', bytes: 5000, targets: [{ status: 'scheduled' }] });
  makePost({ file: 'twice.jpg', bytes: 5000, targets: [{ status: 'scheduled' }] });
  assert.equal(usedBytes() - before, 5000);
});

test('снятые файлы места не занимают', () => {
  const before = usedBytes();
  makePost({ bytes: 7000, targets: [{ status: 'published', publishedAgo: RETENTION.image + MINUTE }] });
  assert.equal(usedBytes() - before, 7000);
  purgePublishedMedia();
  assert.equal(usedBytes(), before);
});

test('квота отказывает до записи, а не после', () => {
  // Квота в этом тесте — 1 МБ.
  assert.equal(quotaCheck(100).ok, true);
  assert.equal(quotaCheck(2 * 1024 * 1024).ok, false);
});
