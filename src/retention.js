/**
 * Сколько живёт файл кадра на диске.
 *
 * Диск у панели общий с шестнадцатью сайтами сети, и забитый диск кладёт не
 * панель, а всё сразу. А файлы копились: опубликованный пост хранил свои кадры
 * вечно, хотя площадкам они больше не нужны — те забирают файл по ссылке в
 * момент публикации и дальше держат у себя.
 *
 * Правило одно: **файл живёт, пока нужен хотя бы одному живому посту.**
 * Живой — неудалённый пост, у которого есть хоть одна неопубликованная цель
 * (или целей нет вовсе — это черновик). Из правила сами собой следуют все
 * случаи, на которых легко ошибиться:
 *
 *   — частичная публикация: одна площадка упала, файл нужен для повтора;
 *   — вечнозелёная рубрика: копия поста ссылается на ТОТ ЖЕ файл, что и
 *     опубликованный оригинал, и уйдёт в сеть через неделю;
 *   — «ждёт ручной проверки»: судьба неизвестна, повтор возможен.
 *
 * Когда живых постов у файла не осталось, он удаляется не сразу, а после
 * короткого окна. Подтверждением служит id публикации, который вернула каждая
 * площадка, а окно нужно потому, что подтверждение приходит раньше, чем
 * площадка заканчивает работу с файлом: Facebook отвечает на загрузку видео
 * сразу, а скачивает и обрабатывает его уже после.
 *
 * Строка о файле в базе остаётся — это история. Помечается `purged_at`.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, log } from './db.js';
import { UPLOAD_DIR, THUMB_DIR, removeStored } from './media.js';

export const MINUTE = 60 * 1000;

/**
 * Окна после публикации.
 *
 * Картинку Instagram, Threads и Facebook скачивают в момент вызова и к
 * ответу уже держат у себя — десять минут здесь чистый запас. Видео Facebook
 * обрабатывает после ответа, и минуты там бывают десятками.
 */
export const RETENTION = {
  image: Number(process.env.RETAIN_IMAGE_MIN || 10) * MINUTE,
  video: Number(process.env.RETAIN_VIDEO_MIN || 180) * MINUTE,
};

/** Сколько места под загрузки, пока панель не начнёт отказывать в новых. */
export const QUOTA_BYTES = Number(process.env.UPLOAD_QUOTA_MB || 2048) * 1024 * 1024;

/** Время из базы: `datetime('now')` пишет UTC без зоны. */
function fromDb(stamp) {
  if (!stamp) return null;
  const ms = new Date(`${String(stamp).replace(' ', 'T')}Z`).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Вердикт по одному файлу.
 *
 * @param {Array<{kind: string, deleted_at: string|null, targets: Array<{status: string, published_at: string|null}>}>} uses
 *   все посты, чьи кадры ссылаются на этот файл
 * @returns {{keep: true, reason: string} | {keep: false, releaseAt: number}}
 */
export function verdict(uses, now = Date.now()) {
  if (!uses.length) return { keep: false, releaseAt: now };

  let releaseAt = 0;
  for (const use of uses) {
    const alive =
      !use.deleted_at && (use.targets.length === 0 || use.targets.some((t) => t.status !== 'published'));
    if (alive) {
      return { keep: true, reason: use.targets.length ? 'пост ещё не ушёл во все сети' : 'черновик' };
    }

    const window = use.kind === 'video' ? RETENTION.video : RETENTION.image;
    const lastPublished = Math.max(0, ...use.targets.map((t) => fromDb(t.published_at) || 0));
    // У удалённого поста публикаций могло не быть вовсе — тогда отсчёт от
    // самого удаления, чтобы не держать файл удалённого черновика.
    const from = Math.max(lastPublished, fromDb(use.deleted_at) || 0);
    releaseAt = Math.max(releaseAt, from + window);
  }

  return releaseAt <= now ? { keep: false, releaseAt } : { keep: true, reason: 'идёт окно после публикации', releaseAt };
}

/** Все посты, которым нужен файл, — в том виде, что понимает `verdict`. */
function usesOf(storedName) {
  const rows = db
    .prepare(
      `SELECT m.kind, p.id AS post_id, p.deleted_at
         FROM media m JOIN posts p ON p.id = m.post_id
        WHERE m.stored_name = ?`
    )
    .all(storedName);
  const targets = db.prepare('SELECT status, published_at FROM post_targets WHERE post_id = ?');
  return rows.map((r) => ({ kind: r.kind, deleted_at: r.deleted_at, targets: targets.all(r.post_id) }));
}

/**
 * Снять файл с диска, если он больше никому не нужен.
 *
 * Отдельная функция потому, что удалять файл «по месту» нельзя нигде: у
 * вечнозелёной копии тот же файл, и снятие кадра с одного поста стирало
 * его у всех копий разом.
 *
 * @returns {boolean} удалён ли файл
 */
export function releaseFile(storedName, now = Date.now()) {
  if (!storedName) return false;
  const v = verdict(usesOf(storedName), now);
  if (v.keep) return false;

  const removed = removeStored(storedName);
  // Отметку ставим и когда файла уже не было: иначе обход спотыкался бы о
  // него каждые десять минут.
  db.prepare("UPDATE media SET purged_at = datetime('now') WHERE stored_name = ? AND purged_at IS NULL").run(
    storedName
  );
  return removed;
}

/**
 * Снять миниатюру, если на неё не осталось ни одной записи.
 *
 * Правило другое, чем у оригинала: миниатюра — это история, и живёт она ровно
 * столько, сколько запись о кадре. Публикация её не снимает — ради этого она и
 * заведена. Уходит, когда кадр сняли с поста или пост стёрли целиком, — и
 * тоже с оглядкой на вечнозелёную копию с той же миниатюрой.
 */
export function releaseThumb(thumbName) {
  if (!thumbName) return false;
  const still = db.prepare('SELECT 1 FROM media WHERE thumb_name = ? LIMIT 1').get(thumbName);
  if (still) return false;
  return removeStored(thumbName, THUMB_DIR);
}

/**
 * Обход: снять всё, чему вышло время. Зовёт воркер.
 *
 * Идёт только по файлам, у которых нет живых постов, — это отсекается одним
 * запросом, и каждые десять минут перебирать весь архив не приходится.
 */
export function purgePublishedMedia(now = Date.now()) {
  const candidates = db
    .prepare(
      `SELECT DISTINCT m.stored_name
         FROM media m
        WHERE m.purged_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM media m2 JOIN posts p ON p.id = m2.post_id
             WHERE m2.stored_name = m.stored_name
               AND p.deleted_at IS NULL
               AND (NOT EXISTS (SELECT 1 FROM post_targets t WHERE t.post_id = p.id)
                    OR EXISTS (SELECT 1 FROM post_targets t WHERE t.post_id = p.id AND t.status != 'published'))
          )`
    )
    .all()
    .map((r) => r.stored_name);

  let removed = 0;
  let bytes = 0;
  for (const name of candidates) {
    const size = db.prepare('SELECT bytes FROM media WHERE stored_name = ? LIMIT 1').get(name)?.bytes || 0;
    if (releaseFile(name, now)) {
      removed += 1;
      bytes += size;
    }
  }
  if (removed) log('info', `сняты с диска файлы опубликованных постов: ${removed}, ${Math.round(bytes / 1048576)} МБ`);
  return { removed, bytes };
}

/**
 * Сколько занято файлами, которые ещё лежат на диске: живые оригиналы плюс
 * миниатюры. Миниатюры копятся с историей и не снимаются после публикации —
 * мелкие, но предохранитель диска обязан видеть и их.
 */
export function usedBytes() {
  const originals =
    db
      .prepare(
        `SELECT COALESCE(SUM(bytes), 0) AS total FROM (
           SELECT stored_name, MAX(bytes) AS bytes FROM media WHERE purged_at IS NULL GROUP BY stored_name
         )`
      )
      .get().total || 0;
  const thumbs =
    db
      .prepare(
        `SELECT COALESCE(SUM(bytes), 0) AS total FROM (
           SELECT thumb_name, MAX(thumb_bytes) AS bytes FROM media WHERE thumb_name IS NOT NULL GROUP BY thumb_name
         )`
      )
      .get().total || 0;
  return originals + thumbs;
}

/**
 * Влезет ли ещё столько байт.
 *
 * Считается по базе, а не обходом диска: обход каталога на каждую загрузку
 * подвешивал бы интерфейс тем сильнее, чем больше накопилось.
 */
export function quotaCheck(incomingBytes = 0) {
  const used = usedBytes();
  return { ok: used + incomingBytes <= QUOTA_BYTES, used, quota: QUOTA_BYTES };
}

/** Файл кадра на месте? Проверка перед публикацией. */
export function fileExists(storedName) {
  return Boolean(storedName) && existsSync(resolve(UPLOAD_DIR, storedName));
}
