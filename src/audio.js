/**
 * Звук у цели поста: как хранится, как чистится, как следится.
 *
 * Хранится JSON-строкой в `post_targets.audio` — у цели, а не у поста: звук
 * бывает только у Instagram, и только у Reels. Внутри — ровно то, что нужно
 * показать карточку трека без похода к площадке и прикрепить его при
 * публикации:
 *
 *   { id, type, title, artist, username, durationMs, cover,
 *     audioVolume, videoVolume, ownName, missing, checkedAt }
 *
 * Ссылку на прослушку (`download_url`) не храним: она живёт полтора дня,
 * композер берёт свежую при открытии.
 */

import { AUDIO_TYPES, audioLabel, isGone } from './platforms/instagram-audio.js';

export { audioLabel };

/**
 * Можно ли этой цели звук. Instagram прикрепляет его только к Reels, а
 * Reels — это ровно один ролик: одиночное видео и в ленте уходит Reels,
 * а фото, карусель и сторис звука через API не получают.
 */
export function audioAllowed(format, media) {
  if (!format || format.role === 'story') return false;
  return media.length === 1 && media[0].kind === 'video';
}

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function volume(v, fallback = 100) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
}

function cover(url) {
  if (typeof url !== 'string' || url.length > 2000) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)fbcdn\.net$/.test(u.hostname) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Присланное браузером → то, что можно положить в базу. Пустое — `null`:
 * ни трека, ни названия своего звука.
 */
export function sanitizeAudio(input) {
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!input || typeof input !== 'object') return null;

  const id = /^\d{3,30}$/.test(String(input.id ?? '')) ? String(input.id) : null;
  const ownName = text(input.ownName, 100);
  if (!id && !ownName) return null;

  const out = {};
  if (id) {
    out.id = id;
    out.type = AUDIO_TYPES.includes(input.type) ? input.type : 'music';
    out.title = text(input.title, 200) || '';
    out.artist = text(input.artist, 100);
    out.username = text(input.username, 100);
    const ms = Math.round(Number(input.durationMs));
    out.durationMs = Number.isFinite(ms) && ms > 0 ? ms : null;
    out.cover = cover(input.cover);
    out.audioVolume = volume(input.audioVolume);
    out.videoVolume = volume(input.videoVolume);
    // Отметку о пропаже ставит сторож, но композер сохраняет цель целиком —
    // и без этого отметка слетала бы до следующего обхода.
    if (input.missing === true) out.missing = true;
    if (text(input.checkedAt, 40)) out.checkedAt = text(input.checkedAt, 40);
  } else {
    out.ownName = ownName;
  }
  return out;
}

/** Из базы (строка) или из интерфейса (объект) — одинаково. */
export function parseAudio(value) {
  return sanitizeAudio(value);
}

export function storeAudio(value) {
  const clean = sanitizeAudio(value);
  return clean ? JSON.stringify(clean) : null;
}

/**
 * Сторож звука у ближайших постов.
 *
 * Трек выбирают за дни до публикации, а библиотека Instagram меняется: звук
 * убирают правообладатели, автор удаляет свой Reels с оригинальным звуком.
 * Публикация такого поста упадёт — лучше узнать за сутки, пока есть время
 * выбрать другой, чем в момент выхода.
 *
 * Отметка `missing` пишется в сам звук цели: по ней проверка поста в
 * композере показывает блокер, а журнал получает запись только при смене
 * состояния — без повтора каждый час.
 *
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {(audioId: string, projectId: number) => Promise<unknown>} deps.fetchInfo
 *   бросает GraphError; код 100 значит «звука нет»
 * @param {Function} deps.log
 */
export async function checkUpcomingAudio({ db, fetchInfo, log, horizonHours = 48 }) {
  const rows = db
    .prepare(
      `SELECT t.id, t.post_id, t.audio, p.project_id
         FROM post_targets t JOIN posts p ON p.id = t.post_id
        WHERE t.platform = 'instagram' AND t.audio IS NOT NULL
          AND t.status IN ('pending', 'failed')
          AND p.deleted_at IS NULL
          AND p.status IN ('review', 'scheduled', 'partial', 'failed')
          AND p.scheduled_at IS NOT NULL
          AND p.scheduled_at <= datetime('now', 'localtime', ?)`
    )
    .all(`+${Number(horizonHours)} hours`);

  // Один звук у нескольких постов спрашиваем один раз.
  const verdicts = new Map();
  const update = db.prepare('UPDATE post_targets SET audio = ? WHERE id = ?');
  let missing = 0;

  for (const row of rows) {
    const audio = parseAudio(row.audio);
    if (!audio?.id) continue;
    const key = `${row.project_id}:${audio.id}`;
    if (!verdicts.has(key)) {
      try {
        await fetchInfo(audio.id, row.project_id);
        verdicts.set(key, 'ok');
      } catch (err) {
        // Сбой сети или токена — не повод объявлять звук пропавшим.
        verdicts.set(key, isGone(err) ? 'gone' : 'unknown');
      }
    }
    const verdict = verdicts.get(key);
    if (verdict === 'unknown') continue;

    const gone = verdict === 'gone';
    const next = { ...audio, checkedAt: new Date().toISOString() };
    if (gone) next.missing = true;
    else delete next.missing;
    update.run(JSON.stringify(next), row.id);

    if (gone) missing += 1;
    if (gone && !audio.missing) {
      log('warn', `пост #${row.post_id}: звук Instagram ${audioLabel(audio)} больше недоступен — выберите другой`, {
        postId: row.post_id,
        platform: 'instagram',
      });
    } else if (!gone && audio.missing) {
      log('info', `пост #${row.post_id}: звук Instagram ${audioLabel(audio)} снова доступен`, {
        postId: row.post_id,
        platform: 'instagram',
      });
    }
  }
  return { checked: rows.length, missing };
}
