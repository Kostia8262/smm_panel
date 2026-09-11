/**
 * Проверки очереди публикации.
 *
 * Это единственная часть панели, ошибка в которой видна подписчикам: пост,
 * ушедший дважды, уже не отозвать. Поэтому тесты здесь не про «работает
 * вообще», а про три конкретных случая, каждый из которых у нас был:
 *   — зависший пост не подхватывался никогда;
 *   — прерванная отправка повторялась вслепую;
 *   — правка поста стирала след уже совершённой публикации.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-test-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const { recoverStuck, dueQuery } = await import('../src/queue/recover.js');

const noop = () => {};

before(() => {
  db.exec("INSERT INTO projects (slug, title, position) VALUES ('t', 'Тест', 99)");
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // База может быть ещё занята — временный каталог подчистит система.
  }
});

function makePost({ status = 'scheduled', scheduledAt = "datetime('now', '-1 minute')", publishingSince = 'NULL' } = {}) {
  const info = db
    .prepare(
      `INSERT INTO posts (title, body, status, scheduled_at, publishing_since, project_id)
       VALUES ('тест', 'текст', ?, ${scheduledAt}, ${publishingSince}, 1)`
    )
    .run(status);
  return Number(info.lastInsertRowid);
}

function makeTarget(postId, { platform = 'telegram', status = 'pending', sendingSince = 'NULL' } = {}) {
  const info = db
    .prepare(
      `INSERT INTO post_targets (post_id, platform, format_id, status, sending_since)
       VALUES (?, ?, 'any', ?, ${sendingSince})`
    )
    .run(postId, platform, status);
  return Number(info.lastInsertRowid);
}

const targetOf = (id) => db.prepare('SELECT * FROM post_targets WHERE id = ?').get(id);
const postOf = (id) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id);

test('созревший пост попадает в выборку воркера', () => {
  const id = makePost();
  const due = db.prepare(dueQuery()).all().map((r) => r.id);
  assert.ok(due.includes(id), 'пост со временем в прошлом должен быть выбран');
});

test('пост с будущим временем в выборку не попадает', () => {
  const id = makePost({ scheduledAt: "datetime('now', '+2 hours')" });
  const due = db.prepare(dueQuery()).all().map((r) => r.id);
  assert.ok(!due.includes(id));
});

test('удалённый пост не публикуется', () => {
  const id = makePost();
  db.prepare("UPDATE posts SET deleted_at = datetime('now') WHERE id = ?").run(id);
  const due = db.prepare(dueQuery()).all().map((r) => r.id);
  assert.ok(!due.includes(id), 'мягко удалённый пост уходить в сети не должен');
});

test('зависший в publishing пост возвращается в очередь', () => {
  const id = makePost({ status: 'publishing', publishingSince: "datetime('now', '-30 minutes')" });
  makeTarget(id);

  const before = db.prepare(dueQuery()).all().map((r) => r.id);
  assert.ok(!before.includes(id), 'до разбора зависший пост невидим для воркера');

  recoverStuck(db, noop);

  assert.equal(postOf(id).status, 'scheduled');
  assert.equal(postOf(id).publishing_since, null);
  const after = db.prepare(dueQuery()).all().map((r) => r.id);
  assert.ok(after.includes(id), 'после разбора пост снова в очереди');
});

test('зависший пост с частью опубликованного помечается partial, а не scheduled', () => {
  const id = makePost({ status: 'publishing', publishingSince: "datetime('now', '-30 minutes')" });
  makeTarget(id, { platform: 'telegram', status: 'published' });
  makeTarget(id, { platform: 'threads', status: 'pending' });

  recoverStuck(db, noop);
  assert.equal(postOf(id).status, 'partial');
});

test('прерванная отправка не повторяется молча, а требует проверки', () => {
  const id = makePost({ status: 'publishing', publishingSince: "datetime('now', '-30 minutes')" });
  const target = makeTarget(id, { status: 'sending', sendingSince: "datetime('now', '-30 minutes')" });

  const report = recoverStuck(db, noop);

  assert.equal(report.unknown, 1);
  const row = targetOf(target);
  assert.equal(row.status, 'needs_check', 'судьба неизвестна — решает человек');
  assert.match(row.error, /неизвестно/i);
});

test('свежая отправка не считается зависшей', () => {
  const id = makePost({ status: 'publishing', publishingSince: "datetime('now', '-1 minute')" });
  const target = makeTarget(id, { status: 'sending', sendingSince: "datetime('now', '-1 minute')" });

  recoverStuck(db, noop);

  assert.equal(targetOf(target).status, 'sending', 'минута — не повод объявлять пропажу');
  assert.equal(postOf(id).status, 'publishing');
});
