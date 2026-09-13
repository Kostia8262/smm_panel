/**
 * Отправка одного поста по всем его площадкам.
 *
 * Площадки независимы: упавший Instagram не мешает Telegram. Поэтому статус
 * хранится у каждой цели отдельно, а у поста он сводный — и повтор шлёт
 * только то, что не ушло, без дублей в уже отработавших каналах.
 *
 * Цели **разных** площадок уходят параллельно. До 13.09.2026 шли строго по
 * очереди, и Reels в трёх сетях (каждая ждёт обработки ролика минутами)
 * держали пост полчаса. Цели одной площадки — по-прежнему по очереди: лента и
 * сторис одного аккаунта не должны спорить за его суточный лимит и порядок.
 *
 * Сторис — серия: каждый кадр отдельной публикацией, по порядку. Что уже
 * вышло, пишется в `post_targets.parts` сразу после каждого кадра — упавший
 * третий кадр из пяти не выпускает первые два повторно.
 */

import { resolve } from 'node:path';
import { db, getPost, log } from '../db.js';
import { getAdapter } from '../platforms/index.js';
import { formatOf } from '../platforms/specs.js';
import { credentialsFor, getProject } from '../projects.js';
import { requeueEvergreen } from '../schedule.js';
import { shortenLinks } from '../links.js';
import { withSignature, signatureFor } from '../signature.js';
import { getSetting } from '../staff.js';
import { UPLOAD_DIR } from '../media.js';
import { fileExists } from '../retention.js';
import { mediaFor } from '../validate.js';
import { parseAudio, audioLabel } from '../audio.js';

const MAX_ATTEMPTS = 3;

function publicUrlFactory() {
  const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:3210').replace(/\/$/, '');
  return (m) => `${base}/media/${m.stored_name}`;
}

/**
 * Цель отработала: вышла или уже снята из сети (`removed`, с 13.09.2026).
 * Снятая не должна считаться «не ушедшей» — иначе повтор выпустил бы её снова.
 */
export function isDone(target) {
  return target?.status === 'published' || target?.status === 'removed';
}

/** Что из серии уже вышло: `[{media_id, external_id, url}]`. */
export function partsOf(target) {
  try {
    const parsed = JSON.parse(target?.parts || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function publishPost(postId) {
  const post = getPost(postId);
  if (!post) throw new Error(`Пост #${postId} не найден`);

  // Токены берутся из карточки проекта: пост академии и пост «Дошколярика»
  // уходят в разные аккаунты, хотя код публикации один.
  const project = post.project_id ? getProject(post.project_id) : null;
  if (!project) {
    log('error', `у поста #${postId} нет проекта — публиковать некуда`, { postId });
    db.prepare("UPDATE posts SET status = 'failed' WHERE id = ?").run(postId);
    return { status: 'failed', results: [{ error: 'не указан проект' }] };
  }

  const pending = post.targets.filter((t) => !isDone(t) && t.status !== 'needs_check');

  // Файлы на месте? Площадки скачивают кадр по ссылке сами, и пропавший файл
  // они вернули бы невнятным «не удалось загрузить медиа» — а причина у нас.
  // Уборка (retention.js) живому посту файл не снимает, так что сюда попадает
  // только чрезвычайное: руками почищенный каталог, восстановление из бэкапа
  // без загрузок. Попытки при этом не тратим — чинить здесь человеку.
  // Смотрим только кадры тех целей, что ещё уходят: у каждой цели свои кадры.
  const needed = new Map();
  for (const t of pending) for (const m of mediaFor(post, t)) needed.set(m.id, m);
  const missing = [...needed.values()].filter((m) => m.purged_at || !fileExists(m.stored_name));
  if (missing.length) {
    const names = missing.map((m) => m.original_name).join(', ');
    const message = `нет файла на сервере: ${names} — загрузите кадр заново`;
    for (const target of pending) markFailed(target, message);
    log('error', `пост #${postId} не отправлен: ${message}`, { postId });
    const anyDone = post.targets.some(isDone);
    db.prepare('UPDATE posts SET status = ? WHERE id = ?').run(anyDone ? 'partial' : 'failed', postId);
    return { status: anyDone ? 'partial' : 'failed', results: [{ error: message }] };
  }

  db.prepare("UPDATE posts SET status = 'publishing', publishing_since = datetime('now') WHERE id = ?").run(postId);

  const ctx = { post, project, publicUrl: publicUrlFactory() };
  const results = [];

  const byPlatform = new Map();
  for (const target of post.targets) {
    if (!byPlatform.has(target.platform)) byPlatform.set(target.platform, []);
    byPlatform.get(target.platform).push(target);
  }
  await Promise.all(
    [...byPlatform.values()].map(async (list) => {
      for (const target of list) results.push(await sendTarget(ctx, target));
    })
  );

  const after = getPost(postId);
  const allDone = after.targets.every(isDone);
  const anyDone = after.targets.some(isDone);
  const needsCheck = after.targets.some((t) => t.status === 'needs_check');
  const status = needsCheck ? 'partial' : allDone ? 'published' : anyDone ? 'partial' : 'failed';
  db.prepare(
    "UPDATE posts SET status = ?, publishing_since = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(status, postId);

  // Вечнозелёная рубрика возвращает пост в оборот копией — исходный остаётся
  // в истории с датой и внешними id.
  if (status === 'published') {
    try {
      requeueEvergreen(postId);
    } catch (err) {
      log('warn', `повтор не поставился: ${err.message}`, { postId });
    }
  }

  return { status, results };
}

async function sendTarget({ post, project, publicUrl }, target) {
  const postId = post.id;
  if (target.status === 'published') return { platform: target.platform, skipped: 'уже опубликовано' }; // повтор не дублирует ушедшее
  // Снятый из сети пост обратно сам не выходит: снимали его намеренно.
  if (target.status === 'removed') return { platform: target.platform, skipped: 'снят из сети' };
  // Неизвестную судьбу повторять нельзя: см. queue/recover.js. Такую цель
  // разблокирует только человек, посмотрев в канал.
  if (target.status === 'needs_check') {
    return { platform: target.platform, skipped: 'ждёт ручной проверки' };
  }
  if (target.attempts >= MAX_ATTEMPTS) {
    return { platform: target.platform, skipped: 'исчерпаны попытки' };
  }

  const adapter = getAdapter(target.platform);
  const creds = credentialsFor(project.id, target.platform);
  db.prepare('UPDATE post_targets SET attempts = attempts + 1 WHERE id = ?').run(target.id);

  if (!adapter.isConfigured(creds)) {
    const missing = adapter.missingConfig(creds).join(', ');
    markFailed(target, `Не настроено у проекта «${project.title}»: ${missing}`);
    return { platform: target.platform, error: `не настроено (${missing})` };
  }

  const format = formatOf(target.platform, target.format_id);
  const media = mediaFor(post, target).map((m) => ({ ...m, path: resolve(UPLOAD_DIR, m.stored_name) }));

  if (format?.series) return sendSeries({ postId, target, adapter, creds, media, publicUrl });

  try {
    // Подпись добавляется ДО подмены ссылок: ссылка на сайт внутри подписи
    // тоже должна считать переходы, иначе главный призыв поста остаётся
    // без счётчика.
    const raw = withSignature(target.text_override ?? post.body ?? '', signatureFor(post, project));
    // Ссылки на наши сайты подменяются короткими с метками: иначе потом
    // нечем ответить, сколько человек пришло именно с этого поста.
    const ownDomains = String(getSetting('own_domains', 'mycomputer.education,mycomputer.school'))
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    const text = shortenLinks(raw, {
      post,
      platform: target.platform,
      baseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:3210').replace(/\/$/, ''),
      ownDomains,
    });
    // Отметка ставится ДО вызова площадки. Если процесс умрёт между
    // отправкой и записью результата, мы хотя бы будем знать, что попытка
    // была, и не повторим её вслепую.
    markSending(target);

    // Звук есть только у Instagram; остальным адаптерам поле ни к чему.
    const audio = target.platform === 'instagram' ? parseAudio(target.audio) : null;
    const out = await adapter.publish({ text, media, formatId: target.format_id, publicUrl, creds, audio });
    markPublished(target, out.externalId, out.url);
    log('info', `опубликовано: ${target.platform}`, { postId, platform: target.platform, payload: out });
    // Главное ушло, а хвост — нет (Telegram: продолжение длинной подписи).
    // Цель остаётся вышедшей — повтор выпустил бы пост дублем, — но человек
    // должен узнать, что дослать руками.
    if (out.warning) {
      log('warn', `не ушло в ${target.platform} продолжение поста: ${out.warning}`, { postId, platform: target.platform });
    }
    if (audio?.id && out.audioType === null) {
      log('warn', `пост #${postId}: Instagram выпустил Reels, но звука ${audioLabel(audio)} в нём не видит — проверьте пост`, {
        postId,
        platform: target.platform,
      });
    }
    return { platform: target.platform, ok: true, ...out };
  } catch (err) {
    markFailed(target, err.message);
    log('error', `не ушло в ${target.platform}: ${err.message}`, { postId, platform: target.platform });
    return { platform: target.platform, error: err.message };
  }
}

/**
 * Серия сторис: кадр за кадром, по порядку.
 *
 * Порядок важнее полноты: упал третий кадр — четвёртый и пятый не уходят, иначе
 * подписчик увидит серию вразнобой. Повтор продолжит с упавшего кадра.
 *
 * Текста и подписи у сторис нет — площадки их не показывают, и короткие ссылки
 * под них не заводятся.
 */
async function sendSeries({ postId, target, adapter, creds, media, publicUrl }) {
  if (typeof adapter.publishStory !== 'function') {
    markFailed(target, 'Площадка не публикует сторис');
    return { platform: target.platform, error: 'сторис не поддерживаются' };
  }

  const parts = partsOf(target);
  const done = new Set(parts.map((p) => Number(p.media_id)));
  const total = media.length;

  for (const [i, item] of media.entries()) {
    if (done.has(Number(item.id))) continue;
    markSending(target);
    try {
      const out = await adapter.publishStory({ item, publicUrl, creds });
      parts.push({ media_id: item.id, external_id: out.externalId || null, url: out.url || null });
      db.prepare('UPDATE post_targets SET parts = ? WHERE id = ?').run(JSON.stringify(parts), target.id);
      log('info', `сторис ${i + 1} из ${total} вышла: ${target.platform}`, {
        postId,
        platform: target.platform,
        payload: out,
      });
    } catch (err) {
      const message =
        `Кадр ${i + 1} из ${total} («${item.original_name}») не ушёл: ${err.message}.` +
        (parts.length ? ` Уже вышли: ${parts.length}. Повтор продолжит с этого кадра.` : '');
      markFailed(target, message);
      log('error', `сторис не ушла в ${target.platform}: ${message}`, { postId, platform: target.platform });
      return { platform: target.platform, error: message };
    }
  }

  const first = parts[0] || {};
  markPublished(target, first.external_id, first.url);
  return { platform: target.platform, ok: true, parts: parts.length };
}

function markSending(target) {
  db.prepare("UPDATE post_targets SET status = 'sending', sending_since = datetime('now') WHERE id = ?").run(target.id);
}

function markPublished(target, externalId, url) {
  db.prepare(
    `UPDATE post_targets SET status = 'published', external_id = ?, external_url = ?,
     error = NULL, sending_since = NULL, published_at = datetime('now') WHERE id = ?`
  ).run(externalId || null, url || null, target.id);
}

function markFailed(target, message) {
  db.prepare(
    "UPDATE post_targets SET status = 'failed', error = ?, sending_since = NULL WHERE id = ?"
  ).run(message, target.id);
}
