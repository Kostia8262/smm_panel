/**
 * Сбор трендов Threads по ключевым словам.
 *
 * Что здесь возможно и чего нет. Официальный поиск Threads отдаёт тексты,
 * авторов, ссылки и время — и **не отдаёт ни одной цифры вовлечённости**.
 * Значит тренд для нас это не «сколько лайков собрал пост», а как меняется
 * объём разговора: сегодня по запросу двадцать постов, неделю назад пять.
 *
 * Отсюда устройство: замеры по дням, а не разовый снимок. Без истории рост
 * от падения не отличить, а именно рост и есть сигнал.
 *
 * Второй сигнал — попадание в TOP. `search_type=TOP` возвращает то, что
 * Meta сама сочла лучшим по запросу; сравнение с RECENT показывает, какие
 * посты площадка подняла. Это не цифры, но косвенный признак «зашло».
 */

import { db, log } from '../db.js';
import { credentialsFor } from '../projects.js';
import { keywordSearch } from '../platforms/threads.js';
import { addTrend } from '../plan.js';

/** Что считать заметным ростом: вдвое к прошлой неделе и не меньше пяти постов. */
const GROWTH_FACTOR = 2;
const MIN_VOLUME = 5;

/* ------------------------------ ключевые слова ------------------------------ */

export function listKeywords(projectId) {
  return db
    .prepare('SELECT * FROM trend_keywords WHERE project_id = ? ORDER BY phrase')
    .all(projectId)
    .map((row) => ({ id: row.id, phrase: row.phrase, active: Boolean(row.active) }));
}

export function addKeyword(projectId, phrase) {
  const clean = String(phrase || '').trim();
  if (!clean) throw new Error('Пустая фраза');
  if (clean.length > 80) throw new Error('Фраза длиннее 80 знаков');
  try {
    db.prepare('INSERT INTO trend_keywords (project_id, phrase) VALUES (?, ?)').run(projectId, clean);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new Error('Такая фраза уже отслеживается');
    throw err;
  }
  return listKeywords(projectId);
}

export function removeKeyword(id) {
  db.prepare('DELETE FROM trend_keywords WHERE id = ?').run(id);
}

/* -------------------------------- разбор слов -------------------------------- */

/** Служебные слова, которые иначе возглавят любой список «частых». */
const STOP = new Set(
  ('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ' +
   'ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть ' +
   'был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ' +
   'ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот ' +
   'того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда ' +
   'зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас ' +
   'про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть ' +
   'том нельзя такой им более всегда конечно всю между це на та як у і з до що це не для від про ' +
   'the and for you are with this that have from your').split(/\s+/)
);

/**
 * Слова-спутники: чем ещё сопровождается тема. По ним видно, какими
 * формулировками люди говорят о нашем предмете — сырьё для заголовков.
 */
export function frequentWords(texts, limit = 12) {
  const counts = new Map();
  for (const text of texts) {
    const words = String(text || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .split(/[^\p{L}\p{N}#@_-]+/u);
    const seen = new Set(); // слово считается один раз на пост, иначе победят повторы внутри текста
    for (const word of words) {
      if (word.length < 4 || STOP.has(word) || /^\d+$/.test(word)) continue;
      if (seen.has(word)) continue;
      seen.add(word);
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, n]) => ({ word, posts: n }));
}

function mediaMix(posts) {
  const mix = {};
  for (const p of posts) {
    const key = (p.media_type || 'TEXT').toUpperCase();
    mix[key] = (mix[key] || 0) + 1;
  }
  return mix;
}

/* --------------------------------- сбор --------------------------------- */

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Один замер по одной фразе.
 * @returns {{found: number, topShare: number|null, words: Array}}
 */
export async function measureKeyword(keyword, creds, { now = new Date() } = {}) {
  const [top, recent] = await Promise.all([
    keywordSearch(creds, { q: keyword.phrase, type: 'TOP', limit: 50 }),
    keywordSearch(creds, { q: keyword.phrase, type: 'RECENT', limit: 50 }),
  ]);

  const topIds = new Set(top.map((p) => p.id));
  const all = new Map();
  for (const p of [...recent, ...top]) all.set(p.id, p);

  const posts = [...all.values()];
  const words = frequentWords(posts.map((p) => p.text));
  // Доля свежих постов, которые площадка подняла в TOP: если она высокая,
  // тема сейчас в фаворе у алгоритма.
  const topShare = recent.length ? recent.filter((p) => topIds.has(p.id)).length / recent.length : null;

  const savePost = db.prepare(
    `INSERT INTO trend_posts (keyword_id, external_id, username, text, permalink, media_type, in_top, posted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(keyword_id, external_id) DO UPDATE SET in_top = excluded.in_top`
  );
  for (const p of posts) {
    savePost.run(
      keyword.id,
      p.id,
      p.username || '',
      String(p.text || '').slice(0, 2000),
      p.permalink || null,
      p.media_type || null,
      topIds.has(p.id) ? 1 : 0,
      p.timestamp || null
    );
  }

  db.prepare(
    `INSERT INTO trend_observations (keyword_id, observed_on, found, top_share, media_mix, words)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(keyword_id, observed_on) DO UPDATE SET
       found = excluded.found, top_share = excluded.top_share,
       media_mix = excluded.media_mix, words = excluded.words`
  ).run(
    keyword.id,
    now.toISOString().slice(0, 10),
    posts.length,
    topShare,
    JSON.stringify(mediaMix(posts)),
    JSON.stringify(words)
  );

  return { found: posts.length, topShare, words, posts };
}

/**
 * Сравнение с прошлой неделей. Сигнал рождается только из разницы: «двадцать
 * постов» само по себе ни о чём не говорит, а «вдвое больше, чем неделю
 * назад» — говорит.
 */
export function growthFor(keywordId, { on = today() } = {}) {
  const current = db
    .prepare('SELECT found FROM trend_observations WHERE keyword_id = ? AND observed_on = ?')
    .get(keywordId, on);
  if (!current) return null;

  const past = db
    .prepare(
      `SELECT AVG(found) avg FROM trend_observations
       WHERE keyword_id = ? AND observed_on < ? AND observed_on >= date(?, '-8 days')`
    )
    .get(keywordId, on, on);

  const before = Number(past?.avg) || 0;
  if (!before) return { now: current.found, before: 0, factor: null };
  return { now: current.found, before, factor: current.found / before };
}

/**
 * Полный проход по проекту: замерить все фразы и превратить заметный рост
 * в сигнал на экране «Тренды».
 */
export async function collectForProject(projectId, { now = new Date() } = {}) {
  const creds = credentialsFor(projectId, 'threads');
  if (!creds.accessToken) throw new Error('У проекта не подключён Threads — искать нечем');

  const keywords = listKeywords(projectId).filter((k) => k.active);
  if (!keywords.length) throw new Error('Не заданы фразы для наблюдения');

  const report = { measured: 0, signals: 0, failed: [] };

  for (const keyword of keywords) {
    try {
      const result = await measureKeyword(keyword, creds, { now });
      report.measured += 1;

      const growth = growthFor(keyword.id, { on: now.toISOString().slice(0, 10) });
      if (!growth || growth.factor === null) continue;
      if (result.found < MIN_VOLUME || growth.factor < GROWTH_FACTOR) continue;

      const percent = Math.round((growth.factor - 1) * 100);
      addTrend(
        {
          platform: 'threads',
          projectId,
          source: 'own_stats',
          title: `Растёт тема: «${keyword.phrase}»`,
          summary:
            `Постов по фразе за сутки: ${result.found}, неделей раньше в среднем ` +
            `${growth.before.toFixed(1)}. Часто рядом: ` +
            `${result.words.slice(0, 6).map((w) => w.word).join(', ') || '—'}.`,
          metric: `+${percent}% к прошлой неделе`,
          relevance: percent >= 200 ? 5 : 4,
        },
        'автосбор'
      );
      report.signals += 1;
    } catch (err) {
      report.failed.push({ phrase: keyword.phrase, error: err.message });
      log('warn', `сбор трендов, «${keyword.phrase}»: ${err.message}`);
    }
  }

  log('info', `сбор трендов: замеров ${report.measured}, сигналов ${report.signals}`);
  return report;
}

/** История по фразе — для графика в панели. */
export function historyFor(keywordId, days = 30) {
  return db
    .prepare(
      `SELECT observed_on, found, top_share FROM trend_observations
       WHERE keyword_id = ? AND observed_on >= date('now', ?)
       ORDER BY observed_on`
    )
    .all(keywordId, `-${days} days`);
}
