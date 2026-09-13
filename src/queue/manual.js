/**
 * Ручные действия с уже отправленным: повтор, снятие из сети, разбор
 * «неизвестно, ушёл ли».
 *
 * Появились 13.09.2026 после разбора флоу Telegram. До этого:
 *   — «Повторить неудачные» не сбрасывала счётчик попыток, и после трёх
 *     неудач кнопка молча ничего не делала;
 *   — цель в `needs_check` висела навсегда: снять пометку было нечем;
 *   — удаление поста в панели прятало его у нас, а в сетях он оставался,
 *     и снять его можно было только руками в каждом аккаунте.
 *
 * Сюда вынесено из server.js, чтобы проверять тестом без поднятого сервера.
 */

import { db, getPost, log } from '../db.js';
import { getAdapter } from '../platforms/index.js';
import { credentialsFor, getProject } from '../projects.js';
import { isDone, partsOf, outgoing } from './publish.js';
import { mediaFor } from '../validate.js';

/**
 * Обновить вышедший пост в сети: текст, кнопку, превью, закреп.
 *
 * Медиа не трогаются — площадка их у вышедшего поста не меняет. Что уйдёт,
 * собирается тем же `outgoing`, что и при публикации: с подписью и короткими
 * ссылками.
 */
export async function editTarget(postId, targetId, { adapterFor = getAdapter, credsFor = credentialsFor } = {}) {
  const { post, target } = loadTarget(postId, targetId);
  if (target.status !== 'published') throw httpError(422, 'Обновить можно только вышедший пост');
  const adapter = adapterFor(target.platform);
  if (typeof adapter?.edit !== 'function') throw httpError(422, 'Эта площадка не даёт править вышедший пост');
  if (!target.external_id) throw httpError(422, 'У панели нет id поста — править нечего, только руками');

  const creds = credsFor(post.project_id, target.platform);
  if (typeof adapter.isConfigured === 'function' && !adapter.isConfigured(creds)) {
    throw httpError(422, 'Доступы к площадке у проекта не заполнены');
  }

  const project = post.project_id ? getProject(post.project_id) : null;
  const { text, options } = outgoing(post, project, target);
  let out;
  try {
    out = await adapter.edit(target.external_id, { text, media: mediaFor(post, target), creds, options });
  } catch (err) {
    throw httpError(err.status || 502, err.message);
  }

  if (out?.externalId && out.externalId !== target.external_id) {
    db.prepare('UPDATE post_targets SET external_id = ? WHERE id = ?').run(out.externalId, target.id);
  }
  log('info', `пост #${postId} обновлён в ${target.platform}`, { postId, platform: target.platform, payload: out });
  if (out?.warning) {
    log('warn', `замечание к посту в ${target.platform}: ${out.warning}`, { postId, platform: target.platform });
  }
  return { warning: out?.warning || null };
}

/**
 * Сводный статус поста после ручного действия.
 *
 * `partial`/`scheduled` с целью в `pending` подхватит воркер — так повтор и
 * уходит, без отдельного пути публикации мимо очереди.
 */
export function statusAfterManual(targets) {
  if (targets.every(isDone)) return 'published';
  const anyDone = targets.some(isDone);
  if (targets.some((t) => t.status === 'pending')) return anyDone ? 'partial' : 'scheduled';
  if (targets.some((t) => t.status === 'needs_check')) return 'partial';
  return anyDone ? 'partial' : 'failed';
}

function refreshStatus(postId) {
  const post = getPost(postId);
  const status = statusAfterManual(post.targets);
  db.prepare("UPDATE posts SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, postId);
  return status;
}

/** Поставить не ушедшие цели на повтор — с новыми тремя попытками. */
export function resetForRetry(postId) {
  return db
    .prepare(
      `UPDATE post_targets SET status = 'pending', error = NULL, attempts = 0
       WHERE post_id = ? AND status IN ('failed', 'pending')`
    )
    .run(postId).changes;
}

function loadTarget(postId, targetId) {
  const post = getPost(postId);
  if (!post) throw httpError(404, 'Пост не найден');
  const target = post.targets.find((t) => t.id === Number(targetId));
  if (!target) throw httpError(404, 'У поста нет такой площадки');
  return { post, target };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Разобрать цель с неизвестной судьбой. Решает человек, посмотрев в канал:
 *   `published` — пост в сети есть: отмечаем вышедшим (id у нас нет, поэтому
 *                 снять его из панели потом не получится — только руками);
 *   `retry`     — поста нет: отправляем заново через очередь.
 */
export function resolveUnknown(postId, targetId, outcome) {
  const { target } = loadTarget(postId, targetId);
  if (target.status !== 'needs_check') throw httpError(422, 'Эта площадка не ждёт проверки');

  if (outcome === 'published') {
    db.prepare(
      `UPDATE post_targets SET status = 'published', error = NULL, sending_since = NULL,
       published_at = COALESCE(published_at, datetime('now')) WHERE id = ?`
    ).run(target.id);
    log('info', `пост #${postId} отмечен вышедшим в ${target.platform} после ручной проверки`, {
      postId,
      platform: target.platform,
    });
  } else if (outcome === 'retry') {
    // Серия продолжит с первого не вышедшего кадра: вышедшие лежат в parts.
    db.prepare(
      "UPDATE post_targets SET status = 'pending', error = NULL, sending_since = NULL, attempts = 0 WHERE id = ?"
    ).run(target.id);
    log('warn', `пост #${postId} в ${target.platform} не нашёлся — повтор поставлен в очередь`, {
      postId,
      platform: target.platform,
    });
  } else {
    throw httpError(422, 'Не понимаю решение: нужно published или retry');
  }
  return refreshStatus(postId);
}

/**
 * Снять вышедший пост из одной сети.
 *
 * Серия сторис снимается кадр за кадром; снятые сразу вычёркиваются из
 * `parts`, чтобы повтор после сбоя не спотыкался об уже удалённое.
 */
export async function unpublishTarget(postId, targetId, { adapterFor = getAdapter, credsFor = credentialsFor } = {}) {
  const { post, target } = loadTarget(postId, targetId);
  if (target.status !== 'published') throw httpError(422, 'Снять можно только вышедший пост');

  const adapter = adapterFor(target.platform);
  if (typeof adapter?.remove !== 'function') {
    throw httpError(422, 'Эта площадка не даёт снимать посты через API — снимите руками');
  }

  const parts = partsOf(target);
  const series = parts.length > 0;
  const ids = series ? parts.map((p) => p.external_id).filter(Boolean) : [target.external_id].filter(Boolean);
  if (!ids.length) {
    throw httpError(422, 'Площадка не вернула id поста (или его отметили вышедшим вручную) — снимите руками');
  }

  const creds = credsFor(post.project_id, target.platform);
  if (typeof adapter.isConfigured === 'function' && !adapter.isConfigured(creds)) {
    throw httpError(422, 'Доступы к площадке у проекта не заполнены — снять нечем');
  }
  if (series) {
    const left = [...parts];
    while (left.length) {
      const part = left[0];
      if (part.external_id) {
        try {
          await adapter.remove(part.external_id, creds);
        } catch (err) {
          db.prepare('UPDATE post_targets SET parts = ? WHERE id = ?').run(JSON.stringify(left), target.id);
          throw httpError(502, `Сняты не все кадры (осталось ${left.length}): ${err.message}`);
        }
      }
      left.shift();
    }
  } else {
    try {
      await adapter.remove(target.external_id, creds);
    } catch (err) {
      throw httpError(502, err.message);
    }
  }

  db.prepare("UPDATE post_targets SET status = 'removed', error = NULL WHERE id = ?").run(target.id);
  log('warn', `пост #${postId} снят из сети: ${target.platform}`, { postId, platform: target.platform });
  return refreshStatus(postId);
}
