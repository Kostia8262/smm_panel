/**
 * Контент-план и тренды.
 *
 * Порядок работы, ради которого это сделано:
 *   тренд  →  идея в плане  →  утверждение владельцем  →  пост-заготовка,
 *   в которую СММщик подкладывает картинку  →  очередь  →  публикация.
 *
 * План живёт отдельно от постов намеренно. Идея обсуждается и отклоняется
 * куда чаще, чем публикуется; если держать её постом-черновиком, календарь
 * забьётся тем, что никогда не выйдет, и перестанет отвечать на свой
 * единственный вопрос — «что выйдет на этой неделе».
 */

import { db, log } from './db.js';
import { parseAudio, storeAudio } from './audio.js';

export const PLAN_STATUS = {
  idea: { id: 'idea', title: 'Идея', hint: 'Предложена, ещё не смотрели' },
  approved: { id: 'approved', title: 'Утверждена', hint: 'Владелец согласовал, можно брать в работу' },
  in_work: { id: 'in_work', title: 'В работе', hint: 'Пост создан, ждёт материалов и текста' },
  done: { id: 'done', title: 'Опубликована', hint: 'Пост вышел' },
  rejected: { id: 'rejected', title: 'Отклонена', hint: 'Не берём' },
};

/** Рубрики — не жёсткий справочник, а подсказки: список правит жизнь. */
export const RUBRICS = [
  'Работа ученика',
  'Мем',
  'Набор в группу',
  'Разбор/полезное',
  'Отзыв',
  'Закулисье',
  'Анонс',
];

/**
 * Источники трендов. Пометка `auto` — то, что действительно умеет собираться
 * машиной; у Instagram, Facebook и TikTok публичного API трендов нет вовсе,
 * и туда сигнал попадает только разбором вручную или из нашей же статистики.
 */
export const TREND_SOURCES = {
  research: { id: 'research', title: 'Разбор вручную', auto: false },
  own_stats: { id: 'own_stats', title: 'Наша статистика', auto: true },
  google_trends: { id: 'google_trends', title: 'Google Trends', auto: true },
  youtube: { id: 'youtube', title: 'YouTube в тренде', auto: true },
  // С июня 2026 — первый машинный сигнал от Instagram: трендовые звуки Reels.
  ig_audio: { id: 'ig_audio', title: 'Звуки Instagram', auto: true },
  // Пост аккаунта из списка наблюдения, набравший в разы больше обычного.
  watched: { id: 'watched', title: 'Аккаунты под наблюдением', auto: true },
};

/* -------------------------------- тренды -------------------------------- */

function trendFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    title: row.title,
    summary: row.summary,
    metric: row.metric,
    url: row.url,
    source: row.source,
    sourceTitle: TREND_SOURCES[row.source]?.title || row.source,
    relevance: row.relevance,
    capturedAt: row.captured_at,
    expiresAt: row.expires_at,
    usedCount: row.used_count,
    projectId: row.project_id,
    archived: Boolean(row.archived),
    stale: isStale(row),
    audio: parseAudio(row.audio),
  };
}

/**
 * Протухший тренд опаснее отсутствующего: по нему делают контент, который
 * выглядит вчерашним. Срок берём из самого тренда, а если его не задали —
 * считаем, что сигнал живёт три недели.
 */
function isStale(row) {
  const limit = row.expires_at
    ? new Date(row.expires_at.replace(' ', 'T'))
    : new Date(new Date(row.captured_at.replace(' ', 'T')).getTime() + 21 * 86400000);
  return Date.now() > limit.getTime();
}

/**
 * Тренды проекта плюс общие.
 *
 * Формат, который зашёл в TikTok, полезен всем четырём школам, поэтому
 * сигнал без проекта показывается в каждой вкладке. Привязанный — только
 * в своей: «набор в первый класс» дизайн-школе ни к чему.
 */
export function listTrends({ includeArchived = false, projectId = null } = {}) {
  const where = [];
  const params = [];
  if (!includeArchived) where.push('archived = 0');
  if (projectId) {
    where.push('(project_id = ? OR project_id IS NULL)');
    params.push(projectId);
  }
  const sql = `SELECT * FROM trends ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY relevance DESC, captured_at DESC`;
  return db.prepare(sql).all(...params).map(trendFromRow);
}

export function addTrend(data, authorName = 'панель') {
  const platform = String(data.platform || '').trim();
  const title = String(data.title || '').trim();
  if (!platform) throw new Error('Не указана площадка тренда');
  if (!title) throw new Error('Не указано название тренда');

  const info = db
    .prepare(
      `INSERT INTO trends (platform, title, summary, metric, url, source, relevance, expires_at, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      platform,
      title,
      String(data.summary || '').slice(0, 1000),
      String(data.metric || '').slice(0, 120),
      data.url ? String(data.url).slice(0, 500) : null,
      TREND_SOURCES[data.source] ? data.source : 'research',
      Math.min(5, Math.max(1, Number(data.relevance) || 3)),
      data.expiresAt || null,
      data.projectId || null
    );
  log('info', `добавлен тренд (${platform}): ${title} · ${authorName}`);
  return trendFromRow(db.prepare('SELECT * FROM trends WHERE id = ?').get(info.lastInsertRowid));
}

export function archiveTrend(id, archived = true) {
  db.prepare('UPDATE trends SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  return trendFromRow(db.prepare('SELECT * FROM trends WHERE id = ?').get(id));
}

export function removeTrend(id) {
  db.prepare('DELETE FROM trends WHERE id = ?').run(id);
}

/* ------------------------------ контент-план ------------------------------ */

function planFromRow(row) {
  if (!row) return null;
  let platforms = [];
  try {
    platforms = JSON.parse(row.platforms);
  } catch {
    platforms = [];
  }
  return {
    id: row.id,
    title: row.title,
    idea: row.idea,
    rubric: row.rubric,
    platforms,
    plannedFor: row.planned_for,
    status: row.status,
    statusTitle: PLAN_STATUS[row.status]?.title || row.status,
    needMedia: row.need_media,
    note: row.note,
    projectId: row.project_id,
    trendId: row.trend_id,
    trendTitle: row.trend_title || null,
    postId: row.post_id,
    postStatus: row.post_status || null,
    authorId: row.author_id,
    authorName: row.author_name || null,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}

const PLAN_SELECT = `
  SELECT p.*, t.title AS trend_title, s.name AS author_name, po.status AS post_status
  FROM plan_items p
  LEFT JOIN trends t ON t.id = p.trend_id
  LEFT JOIN staff s ON s.id = p.author_id
  LEFT JOIN posts po ON po.id = p.post_id
`;

export function listPlan({ status = null, projectId = null } = {}) {
  const where = ['p.deleted_at IS NULL'];
  const params = [];
  if (projectId) {
    where.push('p.project_id = ?');
    params.push(projectId);
  }
  if (status) {
    where.push('p.status = ?');
    params.push(status);
  }
  const sql = `${PLAN_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY p.planned_for IS NULL, p.planned_for, p.id`;
  return db.prepare(sql).all(...params).map(planFromRow);
}

export function getPlanItem(id) {
  return planFromRow(db.prepare(`${PLAN_SELECT} WHERE p.id = ?`).get(id));
}

export function createPlanItem(data, authorId) {
  const title = String(data.title || '').trim();
  if (!title) throw new Error('Не указана тема');
  const info = db
    .prepare(
      `INSERT INTO plan_items (title, idea, rubric, platforms, planned_for, need_media, note, trend_id, author_id, status, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title,
      String(data.idea || '').slice(0, 2000),
      String(data.rubric || '').slice(0, 80),
      JSON.stringify(Array.isArray(data.platforms) ? data.platforms : []),
      data.plannedFor || null,
      String(data.needMedia || '').slice(0, 300),
      String(data.note || '').slice(0, 500),
      data.trendId || null,
      authorId,
      PLAN_STATUS[data.status] ? data.status : 'idea',
      data.projectId || null
    );
  if (data.trendId) {
    db.prepare('UPDATE trends SET used_count = used_count + 1 WHERE id = ?').run(data.trendId);
  }
  return getPlanItem(Number(info.lastInsertRowid));
}

export function updatePlanItem(id, data) {
  const item = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
  if (!item) throw new Error('Пункт плана не найден');

  db.prepare(
    `UPDATE plan_items SET title = ?, idea = ?, rubric = ?, platforms = ?, planned_for = ?,
     need_media = ?, note = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    data.title !== undefined ? String(data.title).trim() : item.title,
    data.idea !== undefined ? String(data.idea).slice(0, 2000) : item.idea,
    data.rubric !== undefined ? String(data.rubric).slice(0, 80) : item.rubric,
    data.platforms !== undefined ? JSON.stringify(data.platforms) : item.platforms,
    data.plannedFor !== undefined ? data.plannedFor : item.planned_for,
    data.needMedia !== undefined ? String(data.needMedia).slice(0, 300) : item.need_media,
    data.note !== undefined ? String(data.note).slice(0, 500) : item.note,
    data.status && PLAN_STATUS[data.status] ? data.status : item.status,
    id
  );
  return getPlanItem(id);
}

export function approvePlanItem(id, staffId) {
  db.prepare(
    `UPDATE plan_items SET status = 'approved', approved_by = ?, approved_at = datetime('now'),
     updated_at = datetime('now') WHERE id = ?`
  ).run(staffId, id);
  return getPlanItem(id);
}

/** Идея, дошедшая до поста, не стирается: она часть истории плана. */
export function removePlanItem(id) {
  const item = db.prepare('SELECT post_id FROM plan_items WHERE id = ?').get(id);
  if (item?.post_id) {
    db.prepare("UPDATE plan_items SET deleted_at = datetime('now') WHERE id = ?").run(id);
    return { soft: true };
  }
  db.prepare('DELETE FROM plan_items WHERE id = ?').run(id);
  return { soft: false };
}

/**
 * Заготовка поста из пункта плана.
 *
 * Пост создаётся пустым по медиа и с текстом-тезисами: дальше СММщик
 * подкладывает картинку и доводит текст. Время берём из плана, но если там
 * только дата — ставим десять утра, а не полночь: пост в 00:00 никто не видит.
 */
export function planToPost(id, { db: database = db, staffId }) {
  const item = getPlanItem(id);
  if (!item) throw new Error('Пункт плана не найден');
  if (item.postId) throw new Error('Пост из этой идеи уже создан');

  const when = item.plannedFor ? `${item.plannedFor.slice(0, 10)} 10:00:00` : null;
  const body = [item.idea, item.rubric ? `\n\nРубрика: ${item.rubric}` : ''].join('').trim();

  const info = database
    .prepare('INSERT INTO posts (title, body, scheduled_at, author_id, project_id) VALUES (?, ?, ?, ?, ?)')
    .run(item.title, body, when, staffId, item.projectId || null);
  const postId = Number(info.lastInsertRowid);

  const insertTarget = database.prepare(
    'INSERT OR IGNORE INTO post_targets (post_id, platform, format_id) VALUES (?, ?, ?)'
  );
  for (const target of item.platforms) {
    if (typeof target === 'string') insertTarget.run(postId, target, 'any');
    else if (target?.platform) insertTarget.run(postId, target.platform, target.format_id || 'any');
  }

  // Идея из трендового звука: звук и есть суть идеи, и искать его заново в
  // композере значило бы потерять тот самый трек. Звук бывает только у Reels
  // Instagram — туда пост и нацеливаем.
  const trendAudio = item.trendId
    ? parseAudio(database.prepare('SELECT audio FROM trends WHERE id = ?').get(item.trendId)?.audio)
    : null;
  if (trendAudio?.id) {
    const rows = database
      .prepare("SELECT id, format_id FROM post_targets WHERE post_id = ? AND platform = 'instagram' ORDER BY id")
      .all(postId);
    if (!rows.some((r) => r.format_id === 'reels')) {
      // Площадка без раскладки («any» из плана) становится Reels, а не
      // обрастает второй целью рядом.
      if (rows[0]) database.prepare("UPDATE post_targets SET format_id = 'reels' WHERE id = ?").run(rows[0].id);
      else insertTarget.run(postId, 'instagram', 'reels');
    }
    database
      .prepare("UPDATE post_targets SET audio = ? WHERE post_id = ? AND platform = 'instagram' AND format_id = 'reels'")
      .run(storeAudio(trendAudio), postId);
  }

  database
    .prepare("UPDATE plan_items SET post_id = ?, status = 'in_work', updated_at = datetime('now') WHERE id = ?")
    .run(postId, id);

  log('info', `из плана «${item.title}» создан пост #${postId}`, { postId });
  return { postId, item: getPlanItem(id) };
}

/** Сводка для шапки: сколько идей ждёт решения и сколько утверждённого в работе. */
export function planSummary(projectId = null) {
  const rows = projectId
    ? db.prepare('SELECT status, COUNT(*) n FROM plan_items WHERE project_id = ? GROUP BY status').all(projectId)
    : db.prepare('SELECT status, COUNT(*) n FROM plan_items GROUP BY status').all();
  const out = { idea: 0, approved: 0, in_work: 0, done: 0, rejected: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}
