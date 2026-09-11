/**
 * Проверки приёма чужой ленты и выводов по ней.
 *
 * Два места, где легко соврать самим себе: счётчики, которые со временем
 * растут (и снимок может оказаться хуже предыдущего), и среднее вместо
 * медианы — один залетевший пост делает всю выборку «успешной».
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-obs-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const observed = await import('../src/trends/observed.js');
const { parseCount, parseRelativeAge, usernameFromHref } = await import(
  '../extension/src/parse-numbers.js'
);

const post = (over = {}) => ({
  platform: 'threads',
  externalId: 'abc123',
  username: 'someone',
  text: 'Текст поста про курси програмування',
  permalink: 'https://www.threads.com/@someone/post/abc123',
  mediaType: 'IMAGE',
  postedAt: new Date(Date.now() - 3 * 3600000).toISOString(),
  ageHours: 3,
  likes: 10,
  comments: 2,
  reposts: 1,
  quotes: 0,
  ...over,
});

before(() => {
  db.exec("INSERT INTO projects (slug, title, position) VALUES ('obs', 'Наблюдение', 90)");
});

/* --------------------------- разбор из вёрстки --------------------------- */

test('счётчики читаются в разных форматах', () => {
  assert.equal(parseCount('42'), 42);
  assert.equal(parseCount('1 234'), 1234);
  assert.equal(parseCount('1,234'), 1234, 'английские тысячи');
  assert.equal(parseCount('1,2 тис.'), 1200, 'украинское сокращение');
  assert.equal(parseCount('3,4 тыс.'), 3400);
  assert.equal(parseCount('1.2K'), 1200);
  assert.equal(parseCount('2M'), 2000000);
});

test('пустая кнопка не превращается в число', () => {
  assert.equal(parseCount(''), null);
  assert.equal(parseCount('Подобається'), null);
  assert.equal(parseCount(null), null);
});

test('возраст поста читается из подписи на разных языках', () => {
  assert.equal(parseRelativeAge('3 ч'), 3);
  assert.equal(parseRelativeAge('2 год'), 2);
  assert.equal(parseRelativeAge('45 хв'), 0.75);
  assert.equal(parseRelativeAge('2 д'), 48);
  assert.equal(parseRelativeAge('5h'), 5);
});

test('имя автора вынимается из ссылки', () => {
  assert.equal(usernameFromHref('/@my_computer_academy_'), 'my_computer_academy_');
  assert.equal(usernameFromHref('/explore'), null);
});

/* ------------------------------- приём ------------------------------- */

test('пост принимается и получает оценку', () => {
  const res = observed.ingest([post()]);
  assert.equal(res.saved, 1);
  const row = db.prepare("SELECT * FROM observed_posts WHERE external_id = 'abc123'").get();
  assert.equal(row.likes, 10);
  assert.ok(row.score > 0);
  assert.ok(['hot', 'normal', 'cold'].includes(row.label));
});

test('повторная встреча хранит максимум, а не последний снимок', () => {
  observed.ingest([post({ likes: 50, comments: 9 })]);
  observed.ingest([post({ likes: 12, comments: 1 })]); // застали кэш с прежними цифрами

  const row = db.prepare("SELECT * FROM observed_posts WHERE external_id = 'abc123'").get();
  assert.equal(row.likes, 50, 'меньшая цифра не должна затирать большую');
  assert.equal(row.comments, 9);
});

test('чужая площадка и пост без id отбрасываются', () => {
  const res = observed.ingest([
    post({ externalId: '', likes: 1 }),
    { platform: 'instagram', externalId: 'x1' },
  ]);
  assert.equal(res.saved, 0);
  assert.equal(res.skipped, 2);
});

test('отрицательные и мусорные счётчики не проходят', () => {
  observed.ingest([post({ externalId: 'junk', likes: -5, comments: 'много' })]);
  const row = db.prepare("SELECT * FROM observed_posts WHERE external_id = 'junk'").get();
  assert.equal(row.likes, 0);
  assert.equal(row.comments, 0);
});

/* ------------------------------- выводы ------------------------------- */

test('выводы считают медиану, а не среднее', () => {
  // Девять обычных постов и один залетевший: среднее соврало бы.
  for (let i = 0; i < 9; i++) {
    observed.ingest([post({ externalId: `v${i}`, mediaType: 'VIDEO', likes: 3, comments: 0, reposts: 0 })]);
  }
  observed.ingest([post({ externalId: 'viral', mediaType: 'VIDEO', likes: 9000, comments: 500 })]);

  const d = observed.digest({ days: 7 });
  const video = d.byMedia.find((g) => g.key === 'VIDEO');
  assert.ok(video.posts >= 10);
  assert.ok(video.median < 10, `медиана должна остаться низкой, получили ${video.median}`);
});

test('группа из пары постов в выводы не попадает', () => {
  observed.ingest([post({ externalId: 'solo', mediaType: 'CAROUSEL', likes: 100 })]);
  const d = observed.digest({ days: 7 });
  assert.ok(!d.byMedia.some((g) => g.key === 'CAROUSEL'), 'на одном посте вывода не построишь');
});

test('слишком свежие посты в выводы не идут', () => {
  observed.ingest([post({ externalId: 'fresh', ageHours: 0.2, likes: 0 })]);
  const d = observed.digest({ days: 7, minAge: 2 });
  assert.ok(!d.top.some((p) => p.id && p.text.includes('fresh')));
});
