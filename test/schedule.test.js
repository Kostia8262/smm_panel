/**
 * Проверки слотов и рубрик.
 *
 * Слот, отданный двум постам, — это два поста подряд в один момент, ровно
 * то, от чего сетка расписания и должна избавлять. Поэтому «занятость»
 * проверяется отдельно, а не на глаз.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-sched-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const projects = await import('../src/projects.js');
const schedule = await import('../src/schedule.js');

let projectId;

before(() => {
  projectId = projects.createProject({ slug: 'sched', title: 'Расписание' }).id;
  // Сетка на каждый день недели, чтобы тесты не зависели от того, какой
  // сегодня день: иначе они падали бы по субботам.
  for (let day = 1; day <= 7; day++) {
    schedule.addSlot(projectId, { weekday: day, time: '10:00' });
    schedule.addSlot(projectId, { weekday: day, time: '18:30' });
  }
});

function addPost(scheduledAt, { status = 'scheduled', categoryId = null } = {}) {
  const info = db
    .prepare(
      `INSERT INTO posts (title, body, status, scheduled_at, project_id, category_id)
       VALUES ('тест', '', ?, ?, ?, ?)`
    )
    .run(status, scheduledAt, projectId, categoryId);
  return Number(info.lastInsertRowid);
}

test('ближайший слот находится и лежит в будущем', () => {
  const when = schedule.nextFreeSlot(projectId);
  assert.ok(when, 'сетка задана — слот обязан найтись');
  assert.ok(new Date(when.replace(' ', 'T')) > new Date(), 'слот в прошлом не предлагаем');
  assert.match(when, /(10:00|18:30):00$/);
});

test('занятый слот пропускается', () => {
  const first = schedule.nextFreeSlot(projectId);
  addPost(first);
  const second = schedule.nextFreeSlot(projectId);
  assert.notEqual(second, first, 'второй пост не должен лечь на то же время');
  assert.ok(new Date(second.replace(' ', 'T')) > new Date(first.replace(' ', 'T')));
});

test('удалённый пост освобождает слот', () => {
  const when = schedule.nextFreeSlot(projectId);
  const id = addPost(when);
  assert.notEqual(schedule.nextFreeSlot(projectId), when);

  db.prepare("UPDATE posts SET deleted_at = datetime('now') WHERE id = ?").run(id);
  assert.equal(schedule.nextFreeSlot(projectId), when, 'слот снова свободен');
});

test('черновик слот не занимает', () => {
  const when = schedule.nextFreeSlot(projectId);
  addPost(when, { status: 'draft' });
  assert.equal(schedule.nextFreeSlot(projectId), when, 'черновик без очереди ничего не резервирует');
});

test('слот с рубрикой берёт только свою рубрику', () => {
  const other = projects.createProject({ slug: 'sched2', title: 'Вторая' }).id;
  const memes = schedule.createCategory(other, { title: 'Мемы' });
  const reviews = schedule.createCategory(other, { title: 'Отзывы' });
  schedule.addSlot(other, { weekday: 1, time: '09:00', categoryId: memes.id });

  const forMemes = schedule.nextFreeSlot(other, { categoryId: memes.id });
  assert.ok(forMemes, 'для своей рубрики слот есть');

  const forReviews = schedule.nextFreeSlot(other, { categoryId: reviews.id });
  assert.equal(forReviews, null, 'чужую рубрику в именной слот не кладём');

  const forNobody = schedule.nextFreeSlot(other);
  assert.equal(forNobody, null, 'пост без рубрики в именной слот тоже не лезет');
});

test('пустая сетка честно возвращает пустоту, а не случайное время', () => {
  const bare = projects.createProject({ slug: 'bare', title: 'Без сетки' }).id;
  assert.equal(schedule.nextFreeSlot(bare), null);
});

test('вечнозелёный повтор создаёт копию, не трогая оригинал', () => {
  const evergreen = schedule.createCategory(projectId, {
    title: 'Вечное',
    evergreen: true,
    recycleDays: 1,
  });
  const when = schedule.nextFreeSlot(projectId, { categoryId: evergreen.id });
  const id = addPost(when, { status: 'published', categoryId: evergreen.id });
  db.prepare('UPDATE posts SET recycle = 1 WHERE id = ?').run(id);
  db.prepare(
    "INSERT INTO post_targets (post_id, platform, format_id, status) VALUES (?, 'telegram', 'any', 'published')"
  ).run(id);

  const copy = schedule.requeueEvergreen(id);
  assert.ok(copy, 'повтор должен встать в очередь');

  const original = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  assert.equal(original.status, 'published', 'оригинал остаётся в истории');

  const clone = db.prepare('SELECT * FROM posts WHERE id = ?').get(copy.postId);
  assert.equal(clone.status, 'scheduled');
  assert.equal(clone.recycled_from, id);
  const targets = db.prepare('SELECT status FROM post_targets WHERE post_id = ?').all(copy.postId);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].status, 'pending', 'у копии публикация ещё не совершалась');
});

test('невечнозелёная рубрика повтор не создаёт', () => {
  const once = schedule.createCategory(projectId, { title: 'Разово', evergreen: false });
  const id = addPost(schedule.nextFreeSlot(projectId, { categoryId: once.id }), {
    status: 'published',
    categoryId: once.id,
  });
  db.prepare('UPDATE posts SET recycle = 1 WHERE id = ?').run(id);
  assert.equal(schedule.requeueEvergreen(id), null);
});
