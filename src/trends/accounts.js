/**
 * Аккаунты, за которыми следим: конкуренты, образцы, партнёры.
 *
 * Тренд — это то, что заходит у других прямо сейчас, а лучше всего это видно
 * на конкретных аккаунтах: соседняя школа, блогер, у которого мы учимся
 * подаче. Экран трендов до 13.09.2026 умел следить только за фразами.
 *
 * Что можно собрать машиной — честно по площадкам:
 *   Instagram — Business Discovery на нашем токене страницы: подписчики, число
 *     постов, последние посты с лайками, комментариями и просмотрами Reels.
 *     Только бизнес- и авторские аккаунты (проба 13.09.2026,
 *     tools/discovery-probe.mjs).
 *   Threads — чужие профили закрыты: на стандартном доступе API находит только
 *     официальные аккаунты Meta. Посты берём из того, что увидело расширение.
 *   TikTok, Facebook, Telegram, YouTube — официального доступа к чужим цифрам
 *     нет: аккаунт хранится ссылкой с заметкой, чтобы список был в одном месте.
 *
 * Сигнал на доску трендов — пост, набравший в разы больше обычного для этого
 * же аккаунта. Сравнение со своим обычным, а не с абсолютом: десять тысяч
 * просмотров у школы на две тысячи подписчиков — событие, у блогера — провал.
 */

import { db, log } from '../db.js';
import { credentialsFor } from '../projects.js';
import { addTrend } from '../plan.js';
import { GRAPH_API } from '../platforms/graph.js';

export const ACCOUNT_KINDS = {
  competitor: { id: 'competitor', title: 'Конкурент' },
  inspiration: { id: 'inspiration', title: 'Образец подачи' },
  partner: { id: 'partner', title: 'Партнёр' },
  audience: { id: 'audience', title: 'Где наша аудитория' },
};

/**
 * Площадки: как узнать аккаунт в ссылке, как собрать ссылку обратно и что
 * панель умеет с ним делать.
 */
export const WATCH_PLATFORMS = {
  instagram: {
    id: 'instagram',
    title: 'Instagram',
    mode: 'api',
    hosts: ['instagram.com'],
    pattern: /^[a-z0-9._]{1,30}$/,
    url: (u) => `https://www.instagram.com/${u}/`,
  },
  threads: {
    id: 'threads',
    title: 'Threads',
    mode: 'extension',
    hosts: ['threads.net', 'threads.com'],
    pattern: /^[a-z0-9._]{1,30}$/,
    url: (u) => `https://www.threads.com/@${u}`,
  },
  tiktok: {
    id: 'tiktok',
    title: 'TikTok',
    mode: 'link',
    hosts: ['tiktok.com'],
    pattern: /^[a-z0-9._]{2,24}$/,
    url: (u) => `https://www.tiktok.com/@${u}`,
  },
  facebook: {
    id: 'facebook',
    title: 'Facebook',
    mode: 'link',
    hosts: ['facebook.com', 'fb.com'],
    pattern: /^[a-z0-9.\-]{2,80}$/,
    url: (u) => `https://www.facebook.com/${u}`,
  },
  telegram: {
    id: 'telegram',
    title: 'Telegram',
    mode: 'link',
    hosts: ['t.me', 'telegram.me'],
    pattern: /^[a-z0-9_]{4,32}$/,
    url: (u) => `https://t.me/${u}`,
  },
  youtube: {
    id: 'youtube',
    title: 'YouTube',
    mode: 'link',
    hosts: ['youtube.com'],
    pattern: /^[a-z0-9._\-]{3,40}$/,
    url: (u) => `https://www.youtube.com/@${u}`,
  },
};

const MAX_PER_PROJECT = 40;
const POSTS_PER_CHECK = 25;
/** Во сколько раз больше обычного — уже сигнал. */
const SIGNAL_FACTOR = 3;
/** Меньше постов для сравнения — «обычное» ещё не понятно, сигналов не даём. */
const MIN_BASELINE = 5;
const SIGNAL_WINDOW_DAYS = 7;

/**
 * Аккаунт из того, что вставил человек: `@name`, `name` или ссылка на профиль.
 * Ссылку на пост тоже разбираем по первому сегменту пути — вставляют чаще её.
 */
export function parseAccount(platformId, input) {
  const spec = WATCH_PLATFORMS[platformId];
  if (!spec) throw new Error('Площадка не поддерживается');
  let raw = String(input || '').trim();
  if (!raw) throw new Error('Не указан аккаунт');

  if (/^https?:\/\//i.test(raw) || spec.hosts.some((h) => raw.toLowerCase().startsWith(h))) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      throw new Error('Ссылка не разобралась');
    }
    const host = url.hostname.replace(/^(www\.|m\.)/, '').toLowerCase();
    if (!spec.hosts.includes(host)) throw new Error(`Это ссылка не на ${spec.title}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (platformId === 'facebook' && parts[0] === 'profile.php') raw = url.searchParams.get('id') || '';
    else raw = parts[0] || '';
  }

  const username = raw.replace(/^@/, '').toLowerCase();
  if (!spec.pattern.test(username)) throw new Error(`Не похоже на аккаунт ${spec.title}: «${String(input).slice(0, 60)}»`);
  return username;
}

/* ------------------------------ список ------------------------------ */

export function addAccount(projectId, { platform, username, kind = 'competitor', note = '' }) {
  if (!projectId) throw new Error('Не указан проект');
  const clean = parseAccount(platform, username);
  const count = db.prepare('SELECT COUNT(*) n FROM watched_accounts WHERE project_id = ?').get(projectId).n;
  if (count >= MAX_PER_PROJECT) throw new Error(`Больше ${MAX_PER_PROJECT} аккаунтов на школу не держим — уберите лишние`);
  try {
    const info = db
      .prepare('INSERT INTO watched_accounts (project_id, platform, username, kind, note) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, platform, clean, ACCOUNT_KINDS[kind] ? kind : 'competitor', String(note || '').trim().slice(0, 300));
    log('info', `добавлен тренд-аккаунт (${platform}): @${clean}`);
    return Number(info.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new Error(`За @${clean} в ${WATCH_PLATFORMS[platform].title} уже следим`);
    throw err;
  }
}

export function updateAccount(id, { kind, note }) {
  const row = db.prepare('SELECT * FROM watched_accounts WHERE id = ?').get(id);
  if (!row) throw new Error('Аккаунт не найден');
  db.prepare('UPDATE watched_accounts SET kind = ?, note = ? WHERE id = ?').run(
    kind && ACCOUNT_KINDS[kind] ? kind : row.kind,
    note !== undefined ? String(note).trim().slice(0, 300) : row.note,
    id
  );
}

export function removeAccount(id) {
  db.prepare('DELETE FROM watched_accounts WHERE id = ?').run(id);
}

/** Показатель поста: у Reels — просмотры, у остального — вовлечённость. */
export function scoreOf(post) {
  if (Number.isFinite(post.views) && post.views > 0) return post.views;
  return (post.likes || 0) + 3 * (post.comments || 0);
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Reels сравниваем с Reels, ленту с лентой: просмотры и лайки — разные шкалы. */
function groupOf(post) {
  return post.kind === 'REELS' ? 'reels' : 'feed';
}

function withRatios(posts) {
  const baseline = {};
  for (const group of ['reels', 'feed']) {
    const scores = posts.filter((p) => groupOf(p) === group).map(scoreOf);
    baseline[group] = { median: median(scores), size: scores.length };
  }
  return posts.map((p) => {
    const b = baseline[groupOf(p)];
    const ratio = b.size >= MIN_BASELINE && b.median > 0 ? scoreOf(p) / b.median : null;
    return { ...p, ratio: ratio === null ? null : Math.round(ratio * 10) / 10 };
  });
}

/**
 * Аккаунты для экрана: с приростом подписчиков за неделю и лучшими постами
 * месяца. У Threads посты — из увиденного расширением.
 */
export function listAccounts(projectId = null) {
  const rows = projectId
    ? db.prepare('SELECT * FROM watched_accounts WHERE project_id = ? ORDER BY platform, username').all(projectId)
    : db.prepare('SELECT * FROM watched_accounts ORDER BY project_id, platform, username').all();

  const weekAgo = db.prepare(
    `SELECT followers FROM watched_snapshots
      WHERE account_id = ? AND observed_on <= date('now', '-7 days')
      ORDER BY observed_on DESC LIMIT 1`
  );
  const firstSnap = db.prepare('SELECT followers, observed_on FROM watched_snapshots WHERE account_id = ? ORDER BY observed_on LIMIT 1');
  const postsOf = db.prepare(
    `SELECT external_id, kind, caption, permalink, posted_at, likes, comments, views
       FROM watched_posts WHERE account_id = ? ORDER BY posted_at DESC LIMIT ${POSTS_PER_CHECK}`
  );
  const observedOf = db.prepare(
    `SELECT external_id, text, permalink, posted_at, likes, comments, reposts, score, label
       FROM observed_posts
      WHERE platform = 'threads' AND lower(username) = ? AND last_seen >= datetime('now', '-30 days')
      ORDER BY score DESC LIMIT 3`
  );
  const observedCount = db.prepare(
    `SELECT COUNT(*) n FROM observed_posts
      WHERE platform = 'threads' AND lower(username) = ? AND last_seen >= datetime('now', '-30 days')`
  );

  return rows.map((row) => {
    const spec = WATCH_PLATFORMS[row.platform];
    const base = {
      id: row.id,
      projectId: row.project_id,
      platform: row.platform,
      platformTitle: spec?.title || row.platform,
      username: row.username,
      profileUrl: spec ? spec.url(row.username) : null,
      mode: spec?.mode || 'link',
      kind: row.kind,
      kindTitle: ACCOUNT_KINDS[row.kind]?.title || row.kind,
      note: row.note,
      displayName: row.display_name,
      followers: row.followers,
      mediaCount: row.media_count,
      checkedAt: row.checked_at,
      lastError: row.last_error,
      growth: null,
      topPosts: [],
      seen: null,
    };

    if (row.platform === 'instagram') {
      const past = weekAgo.get(row.id) || firstSnap.get(row.id);
      if (past?.followers && row.followers) base.growth = row.followers - past.followers;
      const month = Date.now() - 30 * 86400000;
      base.topPosts = withRatios(
        postsOf.all(row.id).map((p) => ({
          externalId: p.external_id,
          kind: p.kind,
          caption: p.caption,
          permalink: p.permalink,
          postedAt: p.posted_at,
          likes: p.likes,
          comments: p.comments,
          views: p.views,
        }))
      )
        .filter((p) => !p.postedAt || Date.parse(p.postedAt) >= month)
        .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) || scoreOf(b) - scoreOf(a))
        .slice(0, 3);
    } else if (row.platform === 'threads') {
      base.seen = observedCount.get(row.username).n;
      base.topPosts = observedOf.all(row.username).map((p) => ({
        externalId: p.external_id,
        kind: 'THREADS',
        caption: p.text,
        permalink: p.permalink,
        postedAt: p.posted_at,
        likes: p.likes,
        comments: p.comments,
        views: null,
        label: p.label,
      }));
    }
    return base;
  });
}

/* ------------------------------ сбор ------------------------------ */

/** Отказ Business Discovery — человеческими словами. */
function explain(error) {
  const text = String(error?.message || '');
  if (error?.code === 110 || /cannot be found|invalid user|does not exist|not.*(business|professional)/i.test(text)) {
    return 'Не найден или не бизнес-аккаунт: Instagram отдаёт цифры только бизнес- и авторских аккаунтов';
  }
  if (error?.code === 4 || error?.code === 17 || error?.code === 32) return 'Instagram притормозил запросы — попробуем в следующий обход';
  if (error?.code === 190) return 'Токен Instagram школы не подошёл — переподключите Instagram в карточке проекта';
  return `Instagram не отдал данные: ${text || 'без объяснения'}`;
}

/**
 * Один аккаунт Instagram. Возвращает сколько сигналов добавилось на доску.
 *
 * @param {object} account  строка watched_accounts
 * @param {object} creds    доступы Instagram проекта
 * @param {Function} [fetchImpl]
 */
export async function collectInstagram(account, creds, { fetchImpl = fetch } = {}) {
  const fields =
    `business_discovery.username(${account.username}){username,name,followers_count,media_count,` +
    `media.limit(${POSTS_PER_CHECK}){id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,view_count}}`;
  const qs = new URLSearchParams({ fields, access_token: creds.pageToken });

  let data;
  try {
    const res = await fetchImpl(`${GRAPH_API}/${creds.userId}?${qs}`);
    data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw Object.assign(new Error(data.error?.message || `ошибка ${res.status}`), { code: data.error?.code });
  } catch (err) {
    const message = explain(err);
    db.prepare("UPDATE watched_accounts SET last_error = ?, checked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(
      message,
      account.id
    );
    throw new Error(message);
  }

  const bd = data.business_discovery || {};
  db.prepare(
    `UPDATE watched_accounts SET display_name = ?, followers = ?, media_count = ?, last_error = NULL,
            checked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`
  ).run(bd.name || null, bd.followers_count ?? null, bd.media_count ?? null, account.id);
  if (Number.isFinite(bd.followers_count)) {
    db.prepare(
      `INSERT INTO watched_snapshots (account_id, observed_on, followers, media_count) VALUES (?, date('now'), ?, ?)
       ON CONFLICT(account_id, observed_on) DO UPDATE SET followers = excluded.followers, media_count = excluded.media_count`
    ).run(account.id, bd.followers_count, bd.media_count ?? null);
  }

  const upsert = db.prepare(
    `INSERT INTO watched_posts (account_id, external_id, kind, caption, permalink, posted_at, likes, comments, views)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, external_id) DO UPDATE SET
       likes = excluded.likes, comments = excluded.comments, views = excluded.views,
       caption = excluded.caption, last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
  );
  for (const m of bd.media?.data || []) {
    upsert.run(
      account.id,
      String(m.id),
      m.media_product_type || m.media_type || null,
      String(m.caption || '').slice(0, 2000),
      m.permalink || null,
      isoTime(m.timestamp),
      m.like_count ?? null,
      m.comments_count ?? null,
      m.view_count ?? null
    );
  }
  // Посты, выпавшие из последних 25, для сравнения не нужны — держим таблицу короткой.
  db.prepare(
    `DELETE FROM watched_posts WHERE account_id = ? AND id NOT IN
       (SELECT id FROM watched_posts WHERE account_id = ? ORDER BY posted_at DESC LIMIT ${POSTS_PER_CHECK * 2})`
  ).run(account.id, account.id);

  return signalHits(account);
}

/** Пост недели, набравший в разы больше обычного, — на доску трендов, один раз. */
function signalHits(account) {
  const posts = db
    .prepare(
      `SELECT id, external_id, kind, caption, permalink, posted_at, likes, comments, views, signaled
         FROM watched_posts WHERE account_id = ? ORDER BY posted_at DESC LIMIT ${POSTS_PER_CHECK}`
    )
    .all(account.id)
    .map((p) => ({ ...p, externalId: p.external_id, postedAt: p.posted_at }));
  const since = Date.now() - SIGNAL_WINDOW_DAYS * 86400000;
  let added = 0;

  for (const p of withRatios(posts)) {
    if (p.signaled || p.ratio === null || p.ratio < SIGNAL_FACTOR) continue;
    if (p.postedAt && Date.parse(p.postedAt) < since) continue;
    const reels = p.kind === 'REELS';
    const numbers = [
      reels && p.views ? `${formatCount(p.views)} просмотров` : null,
      `${formatCount(p.likes || 0)} лайков`,
      `${formatCount(p.comments || 0)} комментариев`,
    ]
      .filter(Boolean)
      .join(' · ');
    const caption = String(p.caption || '').replace(/\s+/g, ' ').trim();
    addTrend(
      {
        platform: 'instagram',
        projectId: account.project_id,
        source: 'watched',
        title: `@${account.username}: ${reels ? 'Reels' : 'пост'} набрал ×${p.ratio} к обычному`,
        summary: `${caption ? `«${caption.slice(0, 220)}${caption.length > 220 ? '…' : ''}» ` : ''}${numbers}. Разберите, чем зацепил: тема, первые секунды, звук, подача.`,
        metric: `×${p.ratio} к обычному у @${account.username}`,
        url: p.permalink,
        relevance: p.ratio >= 6 ? 5 : 4,
        expiresAt: db.prepare("SELECT datetime('now', 'localtime', '+10 days') AS at").get().at,
      },
      'наблюдение'
    );
    db.prepare('UPDATE watched_posts SET signaled = 1 WHERE id = ?').run(p.id);
    added += 1;
  }
  return added;
}

/**
 * Время поста в ISO с «Z». Instagram пишет зону без двоеточия
 * (`2026-09-10T16:00:12+0000`) — такую строку разбирает не всякий движок, а
 * сортировка по тексту и окно «за неделю» должны работать одинаково везде.
 */
export function isoTime(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatCount(n) {
  // Дробь — через запятую: «1,3 тыс.», а не «1.3 тыс.».
  const short = (x) => x.toFixed(1).replace(/\.0$/, '').replace('.', ',');
  if (n >= 1e6) return `${short(n / 1e6)} млн`;
  if (n >= 1e3) return `${short(n / 1e3)} тыс.`;
  return String(n);
}

/**
 * Обход аккаунтов Instagram проекта. Остальные площадки машиной не собираются —
 * их в обходе нет.
 */
export async function collectAccounts(projectId, { fetchImpl = fetch } = {}) {
  const creds = credentialsFor(projectId, 'instagram');
  const accounts = db
    .prepare("SELECT * FROM watched_accounts WHERE project_id = ? AND platform = 'instagram' ORDER BY checked_at IS NOT NULL, checked_at")
    .all(projectId);
  const report = { checked: 0, signals: 0, failed: [] };
  if (!accounts.length) return report;
  if (!creds.userId || !creds.pageToken) throw new Error('У проекта не подключён Instagram — смотреть чужие аккаунты нечем');

  for (const account of accounts) {
    try {
      report.signals += await collectInstagram(account, creds, { fetchImpl });
      report.checked += 1;
    } catch (err) {
      report.failed.push({ username: account.username, error: err.message });
    }
  }
  log('info', `сбор трендов: аккаунты — проверено ${report.checked}, сигналов ${report.signals}, не ответили ${report.failed.length}`);
  return report;
}
