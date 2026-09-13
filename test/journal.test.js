/**
 * Проверки журнала.
 *
 * Журнал — место, куда идут с вопросом «почему не ушло». Поэтому проверяется
 * то, что может соврать молча: сбой, попавший не в ту категорию и спрятанный
 * фильтром; служебный пульс, не свернувшийся и снова вытеснивший события;
 * СММщик, увидевший хвост чужого токена; немой воркер, нарисованный живым.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-journal-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db, log } = await import('../src/db.js');
const journal = await import('../src/journal.js');

let projectId;
let postId;

before(() => {
  projectId = Number(
    db.prepare("INSERT INTO projects (slug, title, accent, position) VALUES ('jt', 'Тестова школа', '#7aa7e0', 99)").run()
      .lastInsertRowid
  );
  postId = Number(
    db
      .prepare("INSERT INTO posts (title, body, project_id, status) VALUES ('', ?, ?, 'failed')")
      .run('Набір на осінь відкрито\nдругий рядок', projectId).lastInsertRowid
  );

  log('info', 'воркер запущен, тик 60 с');
  log('info', 'сторож токенов проверил подключений: 3');
  log('info', 'вход: Владелец');
  log('warn', 'неудачный вход по токену …abcdef');
  log('info', `создан пост #${postId}`, { postId });
  log('error', 'не ушло в instagram: Media ID is not available', { postId, platform: 'instagram' });
  log('info', 'опубликовано: telegram', { postId, platform: 'telegram', payload: { url: 'https://t.me/c/1/2' } });
  log('info', 'опубликовано: facebook', { postId, platform: 'facebook', payload: { url: 'javascript:alert(1)' } });
  log('info', `обновлены доступы threads у проекта #${projectId}`);
  log('error', 'Тестова школа: токен threads истёк — публикация туда не уйдёт', { platform: 'threads' });
});

test('категории: сбой публикации — публикации, пульс — служебное', () => {
  const kind = (message, extra = {}) => journal.classify({ message, ...extra });

  assert.equal(kind('не ушло в instagram: boom', { level: 'error', platform: 'instagram', post_id: 1 }).kind, 'publish');
  assert.equal(kind('пост #3 уходит с опозданием на 20 мин', { post_id: 3 }).kind, 'publish');
  assert.equal(kind('пост #3 отправлен на согласование', { post_id: 3 }).kind, 'post');
  assert.equal(kind('неудачный вход по токену …abcdef', { level: 'warn' }).kind, 'people');
  assert.equal(kind('перевыпущен токен: Оля').kind, 'people');
  assert.equal(kind('вход Facebook: найдено страниц 2, ждём выбора').kind, 'access');
  assert.equal(kind('Threads подключён кнопкой: @school').kind, 'access');
  assert.equal(kind('сторож токенов проверил подключений: 3').kind, 'system', 'слово «токен» не делает пульс доступом');
  assert.equal(kind('воркер споткнулся: SQLITE_BUSY', { level: 'error' }).kind, 'system');

  const pulse = kind('воркер запущен, тик 60 с');
  assert.equal(pulse.routine, true);
  assert.equal(kind('воркер споткнулся: boom', { level: 'error' }).routine, false, 'сбой воркера не сворачивается');

  assert.equal(kind('опубликовано: telegram').tone, 'ok');
  assert.equal(kind('что угодно', { level: 'error' }).tone, 'danger');
});

test('СММщик не видит входов и сотрудников, владелец видит', () => {
  const smm = journal.listJournal({ role: 'smm' }).log;
  const owner = journal.listJournal({ role: 'owner' }).log;

  assert.ok(!smm.some((r) => r.kind === 'people'));
  assert.ok(!smm.some((r) => /abcdef/.test(r.message)), 'хвост токена СММщику не уходит');
  assert.ok(owner.some((r) => /abcdef/.test(r.message)));

  const smmSummary = journal.journalSummary({ role: 'smm' });
  const ownerSummary = journal.journalSummary({ role: 'owner' });
  assert.equal(ownerSummary.problems - smmSummary.problems, 1, 'неудачный вход не считается в сводке СММщика');
});

test('фильтры: категория, только проблемы, площадка', () => {
  const publish = journal.listJournal({ role: 'owner', kind: 'publish' }).log;
  assert.equal(publish.length, 3);
  assert.ok(publish.every((r) => r.kind === 'publish'));

  const problems = journal.listJournal({ role: 'owner', problems: true }).log;
  assert.ok(problems.length >= 3);
  assert.ok(problems.every((r) => r.level === 'error' || r.level === 'warn'));

  const threads = journal.listJournal({ role: 'owner', platform: 'threads' }).log;
  assert.equal(threads.length, 1);
  assert.equal(journal.listJournal({ role: 'owner', platform: 'myspace' }).log.length, 10, 'чужая площадка не фильтрует в пустоту');
});

test('поиск без учёта регистра по кириллице, по номеру поста и по тексту поста', () => {
  assert.equal(journal.listJournal({ role: 'owner', q: 'ВОРКЕР' }).log.length, 1);
  assert.equal(journal.listJournal({ role: 'owner', q: 'Instagram' }).log.length, 1);

  const byNumber = journal.listJournal({ role: 'owner', q: `#${postId}` }).log;
  assert.equal(byNumber.length, 4);
  assert.ok(byNumber.every((r) => r.post?.id === postId));

  assert.equal(journal.listJournal({ role: 'owner', q: 'набір на осінь' }).log.length, 4, 'находит записи по тексту поста');
});

test('подгрузка страниц не теряет и не повторяет записи', () => {
  const all = journal.listJournal({ role: 'owner', limit: 300 }).log.map((r) => r.id);
  const seen = [];
  let before = 0;
  for (;;) {
    const page = journal.listJournal({ role: 'owner', limit: 3, before });
    seen.push(...page.log.map((r) => r.id));
    if (!page.nextBefore) break;
    before = page.nextBefore;
  }
  assert.deepEqual(seen, all);
});

test('запись для человека: пост с текстом и проектом, площадка и проект по имени, только http-ссылки', () => {
  const rows = journal.listJournal({ role: 'owner' }).log;

  const failed = rows.find((r) => r.level === 'error' && r.platform === 'instagram');
  assert.equal(failed.message, 'Не ушло в Instagram: Media ID is not available');
  assert.equal(failed.post.title, 'Набір на осінь відкрито');
  assert.equal(failed.post.project.title, 'Тестова школа');
  assert.match(failed.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'время отдаётся с зоной');

  const access = rows.find((r) => /доступы/.test(r.message));
  assert.equal(access.message, 'Обновлены доступы Threads у проекта «Тестова школа»');

  assert.equal(rows.find((r) => r.platform === 'telegram').link, 'https://t.me/c/1/2');
  assert.equal(rows.find((r) => r.platform === 'facebook').link, null, 'javascript: не становится ссылкой');
  assert.ok(!('payload' in failed), 'сырой payload наружу не отдаётся');
});

test('сводка: ушедшее по площадкам, сбои, висящие посты', () => {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(
    "INSERT INTO post_targets (post_id, platform, format_id, status, published_at) VALUES (?, 'telegram', 'any', 'published', ?)"
  ).run(postId, now);

  const s = journal.journalSummary({ role: 'owner' });
  assert.equal(s.published.total, 1);
  assert.deepEqual(s.published.byPlatform, [{ platform: 'telegram', count: 1 }]);
  assert.equal(s.failures.count, 1, 'истёкший токен — не сбой публикации');
  assert.deepEqual(s.waiting.ids, [postId]);

  db.prepare('UPDATE posts SET deleted_at = datetime(\'now\') WHERE id = ?').run(postId);
  assert.equal(journal.journalSummary({ role: 'owner' }).waiting.count, 0, 'убранный пост решения не ждёт');
});

test('воркер: живой, занятый и немой различаются', () => {
  assert.equal(journal.workerState().state, 'unknown');

  journal.workerHeartbeat(60000);
  const now = Date.now();
  assert.equal(journal.workerState(now).state, 'alive');
  assert.equal(journal.workerState(now + 150000).state, 'alive', 'пропущенные два тика — ещё не смерть');
  assert.equal(journal.workerState(now + 190000).state, 'silent');
});
