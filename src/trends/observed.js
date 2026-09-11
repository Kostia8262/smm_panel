/**
 * Чужие посты, увиденные в ленте.
 *
 * Сюда приходит то, что расширение прочитало в браузере СММщика. Ценность
 * не в самих постах, а в выводах: какой формат заходит, в какие часы, какие
 * слова встречаются у взлетевших. Голый список чужих постов никому не нужен.
 */

import { db, log } from '../db.js';
import { momentum, classify } from './momentum.js';
import { frequentWords } from './collector.js';

/**
 * Приём пачки из расширения.
 *
 * Счётчики растут со временем, поэтому храним максимум виденного: пролистав
 * ленту второй раз, можно застать кэш с прежними цифрами, и последний
 * снимок оказался бы хуже предыдущего.
 */
export function ingest(posts, { projectId = null } = {}) {
  if (!Array.isArray(posts) || !posts.length) return { saved: 0, skipped: 0 };

  const upsert = db.prepare(
    `INSERT INTO observed_posts
       (project_id, platform, external_id, username, text, permalink, media_type,
        posted_at, age_hours, likes, comments, reposts, quotes, score, per_hour, label)
     VALUES (@project_id, @platform, @external_id, @username, @text, @permalink, @media_type,
             @posted_at, @age_hours, @likes, @comments, @reposts, @quotes, @score, @per_hour, @label)
     ON CONFLICT(platform, external_id) DO UPDATE SET
       likes     = MAX(observed_posts.likes, excluded.likes),
       comments  = MAX(observed_posts.comments, excluded.comments),
       reposts   = MAX(observed_posts.reposts, excluded.reposts),
       quotes    = MAX(observed_posts.quotes, excluded.quotes),
       score     = MAX(observed_posts.score, excluded.score),
       per_hour  = MAX(observed_posts.per_hour, excluded.per_hour),
       label     = excluded.label,
       age_hours = excluded.age_hours,
       text      = CASE WHEN length(excluded.text) > length(observed_posts.text)
                        THEN excluded.text ELSE observed_posts.text END,
       last_seen = datetime('now')`
  );

  let saved = 0;
  let skipped = 0;

  for (const raw of posts) {
    const externalId = String(raw?.externalId || '').trim();
    if (!externalId || raw.platform !== 'threads') {
      skipped += 1;
      continue;
    }

    const stats = {
      likes: num(raw.likes),
      comments: num(raw.comments),
      reposts: num(raw.reposts),
      quotes: num(raw.quotes),
    };
    const age = Number.isFinite(Number(raw.ageHours)) ? Number(raw.ageHours) : 24;
    const m = momentum(stats, age);
    const verdict = classify(stats, age);

    upsert.run({
      project_id: projectId,
      platform: 'threads',
      external_id: externalId,
      username: String(raw.username || '').slice(0, 80),
      text: String(raw.text || '').slice(0, 2000),
      permalink: raw.permalink ? String(raw.permalink).slice(0, 400) : null,
      media_type: raw.mediaType ? String(raw.mediaType).slice(0, 16) : null,
      posted_at: raw.postedAt || null,
      age_hours: age,
      ...stats,
      score: m.score,
      per_hour: m.perHour,
      label: verdict.label,
    });
    saved += 1;
  }

  if (saved) log('info', `из ленты принято постов: ${saved}`);
  return { saved, skipped };
}

/**
 * Выводы по увиденному за период.
 *
 * Медиана, а не среднее: один залетевший пост с десятью тысячами лайков
 * сдвинет среднее так, что остальные сорок покажутся провалом.
 */
export function digest({ days = 7, projectId = null, minAge = 2 } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM observed_posts
       WHERE platform = 'threads'
         AND last_seen >= datetime('now', ?)
         AND age_hours >= ?
         AND (? IS NULL OR project_id = ? OR project_id IS NULL)
       ORDER BY per_hour DESC`
    )
    .all(`-${days} days`, minAge, projectId, projectId);

  if (!rows.length) return { total: 0, top: [], byMedia: [], byHour: [], words: [] };

  const byMedia = groupStats(rows, (r) => r.media_type || 'TEXT');
  const byHour = groupStats(rows, (r) => hourOf(r.posted_at)).filter((g) => g.key !== null);

  // Слова берём только у взлетевших: у остальных они говорят лишь о том,
  // о чём вообще пишут, а не о том, что срабатывает.
  const hot = rows.filter((r) => r.label === 'hot');
  const words = frequentWords(hot.map((r) => r.text));

  return {
    total: rows.length,
    hot: hot.length,
    top: rows.slice(0, 12).map(publicRow),
    byMedia,
    byHour: byHour.sort((a, b) => b.median - a.median).slice(0, 6),
    words,
  };
}

function groupStats(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.per_hour);
  }
  return [...groups.entries()]
    .map(([key, values]) => ({ key, posts: values.length, median: median(values) }))
    .filter((g) => g.posts >= 3) // на двух постах вывода не построишь
    .sort((a, b) => b.median - a.median);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 100) / 100;
}

function hourOf(postedAt) {
  if (!postedAt) return null;
  const at = new Date(String(postedAt).replace(' ', 'T'));
  return Number.isNaN(at.getTime()) ? null : at.getHours();
}

function publicRow(row) {
  return {
    id: row.id,
    username: row.username,
    text: row.text.slice(0, 240),
    permalink: row.permalink,
    mediaType: row.media_type,
    likes: row.likes,
    comments: row.comments,
    reposts: row.reposts,
    perHour: Math.round(row.per_hour * 10) / 10,
    label: row.label,
    ageHours: Math.round(row.age_hours),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/** Старое чистим: лента месячной давности ничего не подсказывает. */
export function prune(days = 45) {
  const info = db
    .prepare(`DELETE FROM observed_posts WHERE last_seen < datetime('now', ?)`)
    .run(`-${days} days`);
  return info.changes || 0;
}
