/**
 * Разбор зависших отправок.
 *
 * Панель не может узнать, ушёл ли пост, если процесс умер посреди вызова
 * площадки. Telegram, Instagram и TikTok не дают ключа идемпотентности:
 * повторив запрос, мы либо починим пропажу, либо опубликуем дубль, и
 * различить эти два случая заранее нельзя.
 *
 * Поэтому здесь не «повторить молча». Отметка `sending_since` ставится ДО
 * вызова площадки; найденная при старте отметка означает ровно одно —
 * «не знаем, ушло или нет». Такая цель уходит в `needs_check`, и человек
 * решает сам, посмотрев в канал. Молчаливый повтор был бы удобнее и хуже:
 * дубль в пяти сетях заметят подписчики, а не мы.
 */

/** Сколько ждём, прежде чем счесть отправку зависшей. */
export const STALE_MINUTES = 15;

/**
 * `busyPostIds` — посты, которые этот же процесс публикует прямо сейчас.
 *
 * Пока воркер публиковал по одному посту, разбор шёл только в простое, и
 * живая отправка зависшей не считалась. С 13.09.2026 посты уходят параллельно,
 * и разбор идёт рядом с идущей публикацией: серия сторис из пяти роликов
 * легко длится дольше пятнадцати минут. Без этого списка её объявили бы
 * зависшей, вернули в очередь — и выпустили повторно, дублем.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {(level: string, message: string, extra?: object) => void} log
 * @param {{staleMinutes?: number, busyPostIds?: Iterable<number>}} opts
 * @returns {{unknown: number, resumed: number}}
 */
export function recoverStuck(db, log, { staleMinutes = STALE_MINUTES, busyPostIds = [] } = {}) {
  const cutoff = `-${staleMinutes} minutes`;
  const busy = new Set([...busyPostIds].map(Number));

  // 1. Цели, застрявшие в момент отправки: судьба неизвестна.
  const hanging = db
    .prepare(
      `SELECT t.id, t.post_id, t.platform, t.parts
       FROM post_targets t
       WHERE t.status = 'sending'
         AND t.sending_since IS NOT NULL
         AND datetime(t.sending_since) < datetime('now', ?)`
    )
    .all(cutoff)
    .filter((row) => !busy.has(Number(row.post_id)));

  const markUnknown = db.prepare("UPDATE post_targets SET status = 'needs_check', error = ? WHERE id = ?");
  for (const row of hanging) {
    // У серии сторис часть кадров могла выйти до обрыва — человеку надо знать,
    // сколько искать в канале.
    let done = 0;
    try {
      done = JSON.parse(row.parts || '[]').length;
    } catch {
      done = 0;
    }
    const message = done
      ? `Отправка серии прервалась: вышли ${done} кадр(а), судьба следующего неизвестна. Проверьте сторис вручную.`
      : 'Отправка прервалась — неизвестно, вышел ли пост. Проверьте канал вручную.';
    markUnknown.run(message, row.id);
    log('warn', `не знаем, ушёл ли пост #${row.post_id} в ${row.platform} — нужна проверка`, {
      postId: row.post_id,
      platform: row.platform,
    });
  }

  // 2. Посты, зависшие в `publishing`: возвращаем в очередь, но только те
  //    цели, что до отправки не дошли. Уже ушедшее не трогаем.
  const stuckPosts = db
    .prepare(
      `SELECT id FROM posts
       WHERE status = 'publishing'
         AND (publishing_since IS NULL OR datetime(publishing_since) < datetime('now', ?))`
    )
    .all(cutoff)
    .filter((row) => !busy.has(Number(row.id)));

  const restore = db.prepare(
    `UPDATE posts SET status = CASE
        WHEN (SELECT COUNT(*) FROM post_targets WHERE post_id = posts.id AND status = 'published') > 0
          THEN 'partial'
        ELSE 'scheduled'
      END,
      publishing_since = NULL
     WHERE id = ?`
  );
  for (const row of stuckPosts) {
    restore.run(row.id);
    log('warn', `пост #${row.id} завис в отправке и возвращён в очередь`, { postId: row.id });
  }

  return { unknown: hanging.length, resumed: stuckPosts.length };
}

/**
 * Что воркер считает созревшим. Вынесено отдельно, чтобы проверять выборку
 * тестом, а не глазами: именно здесь жила ошибка, из-за которой зависший
 * пост не подхватывался никогда.
 */
export function dueQuery() {
  return `SELECT id, scheduled_at FROM posts
          WHERE status IN ('scheduled', 'partial')
            AND deleted_at IS NULL
            AND scheduled_at IS NOT NULL
            AND datetime(scheduled_at) <= datetime('now')
          ORDER BY scheduled_at
          LIMIT 5`;
}
