/**
 * Проверки сбора трендов и оценки «зашёл ли пост».
 *
 * Тренд у нас считается из разницы, а не из абсолютной цифры, поэтому
 * главное здесь — что рост считается от истории и что одиночный всплеск
 * на пустом месте сигналом не становится.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-trends-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const projects = await import('../src/projects.js');
const { momentum, classify, ageHoursOf } = await import('../src/trends/momentum.js');
const collector = await import('../src/trends/collector.js');

let projectId;

before(() => {
  projectId = projects.createProject({ slug: 'tr', title: 'Тренды' }).id;
});

/* ------------------------------- моментум ------------------------------- */

test('комментарии и репосты весят больше лайков', () => {
  assert.equal(momentum({ likes: 12 }, 2).score, 12);
  assert.equal(momentum({ comments: 4 }, 2).score, 12);
  assert.equal(momentum({ reposts: 3 }, 2).score, 12);
});

test('скорость считается от возраста, а не от абсолютной цифры', () => {
  const fresh = momentum({ likes: 20 }, 1);
  const old = momentum({ likes: 20 }, 100);
  assert.ok(fresh.perHour > old.perHour * 50, 'двадцать лайков за час — не то же, что за неделю');
});

test('совсем свежий пост не делится на ноль', () => {
  const m = momentum({ likes: 3 }, 0);
  assert.ok(Number.isFinite(m.perHour));
  assert.ok(m.perHour <= 3 / 0.35 + 0.001);
});

test('быстрый отклик на свежем посте — «зашёл»', () => {
  assert.equal(classify({ likes: 6 }, 1).label, 'hot');
});

test('те же цифры на суточном посте — не «зашёл»', () => {
  assert.notEqual(classify({ likes: 6 }, 24).label, 'hot');
});

test('тишина через час — «не пошёл»', () => {
  const res = classify({ likes: 0, comments: 0, reposts: 0 }, 3);
  assert.equal(res.label, 'cold');
  assert.match(res.reason, /слабая реакция/);
});

test('сотня лайков — «зашёл» в любом возрасте', () => {
  assert.equal(classify({ likes: 120 }, 200).label, 'hot');
});

test('возраст берётся из местного времени базы', () => {
  const now = new Date('2026-09-11T12:00:00');
  assert.equal(Math.round(ageHoursOf('2026-09-11 09:00:00', now)), 3);
  assert.equal(ageHoursOf(null, now), 24, 'без даты считаем сутки, а не бесконечность');
});

/* ------------------------------ слова-спутники ------------------------------ */

test('частые слова находятся, служебные отсеиваются', () => {
  const words = collector.frequentWords([
    'Курси програмування для дітей у Дніпрі',
    'Шукаю курси програмування для дитини',
    'Програмування це те що потрібно',
  ]);
  const list = words.map((w) => w.word);
  assert.ok(list.includes('програмування'));
  assert.ok(!list.includes('для'), 'служебное слово не должно возглавлять список');
});

test('повтор слова внутри одного поста не накручивает счёт', () => {
  const words = collector.frequentWords(['робот робот робот робот', 'робот у школі']);
  const robot = words.find((w) => w.word === 'робот');
  assert.equal(robot.posts, 2, 'считаем посты, а не упоминания');
});

/* --------------------------------- рост --------------------------------- */

function observe(keywordId, day, found) {
  db.prepare(
    'INSERT INTO trend_observations (keyword_id, observed_on, found) VALUES (?, ?, ?)'
  ).run(keywordId, day, found);
}

test('рост считается относительно прошлой недели', () => {
  collector.addKeyword(projectId, 'курси програмування');
  const id = collector.listKeywords(projectId)[0].id;

  observe(id, '2026-09-05', 4);
  observe(id, '2026-09-06', 6);
  observe(id, '2026-09-10', 20);

  const growth = collector.growthFor(id, { on: '2026-09-10' });
  assert.equal(growth.now, 20);
  assert.equal(growth.before, 5);
  assert.equal(growth.factor, 4);
});

test('без истории рост не выдумывается', () => {
  collector.addKeyword(projectId, 'нова фраза');
  const id = collector.listKeywords(projectId).find((k) => k.phrase === 'нова фраза').id;
  observe(id, '2026-09-10', 30);

  const growth = collector.growthFor(id, { on: '2026-09-10' });
  assert.equal(growth.factor, null, 'сравнивать не с чем — это не рост, а первый замер');
});

test('фраза не добавляется дважды', () => {
  assert.throws(() => collector.addKeyword(projectId, 'курси програмування'), /уже отслеживается/);
});
