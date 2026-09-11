/**
 * Отправка одного поста по всем его площадкам.
 *
 * Площадки независимы: упавший Instagram не мешает Telegram. Поэтому статус
 * хранится у каждой цели отдельно, а у поста он сводный — и повтор шлёт
 * только то, что не ушло, без дублей в уже отработавших каналах.
 */

import { resolve } from 'node:path';
import { db, getPost, log } from '../db.js';
import { getAdapter } from '../platforms/index.js';
import { credentialsFor, getProject } from '../projects.js';
import { UPLOAD_DIR } from '../media.js';

const MAX_ATTEMPTS = 3;

function publicUrlFactory() {
  const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:3210').replace(/\/$/, '');
  return (m) => `${base}/media/${m.stored_name}`;
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

  db.prepare("UPDATE posts SET status = 'publishing' WHERE id = ?").run(postId);

  const publicUrl = publicUrlFactory();
  const media = post.media.map((m) => ({ ...m, path: resolve(UPLOAD_DIR, m.stored_name) }));
  const results = [];

  for (const target of post.targets) {
    if (target.status === 'published') continue; // повтор не дублирует ушедшее
    if (target.attempts >= MAX_ATTEMPTS) {
      results.push({ platform: target.platform, skipped: 'исчерпаны попытки' });
      continue;
    }

    const adapter = getAdapter(target.platform);
    const creds = credentialsFor(project.id, target.platform);
    db.prepare('UPDATE post_targets SET attempts = attempts + 1 WHERE id = ?').run(target.id);

    if (!adapter.isConfigured(creds)) {
      const missing = adapter.missingConfig(creds).join(', ');
      markFailed(target, `Не настроено у проекта «${project.title}»: ${missing}`);
      results.push({ platform: target.platform, error: `не настроено (${missing})` });
      continue;
    }

    try {
      const text = target.text_override ?? post.body ?? '';
      const out = await adapter.publish({ text, media, formatId: target.format_id, publicUrl, creds });
      db.prepare(
        `UPDATE post_targets SET status = 'published', external_id = ?, external_url = ?,
         error = NULL, published_at = datetime('now') WHERE id = ?`
      ).run(out.externalId || null, out.url || null, target.id);
      log('info', `опубликовано: ${target.platform}`, {
        postId,
        platform: target.platform,
        payload: out,
      });
      results.push({ platform: target.platform, ok: true, ...out });
    } catch (err) {
      markFailed(target, err.message);
      log('error', `не ушло в ${target.platform}: ${err.message}`, {
        postId,
        platform: target.platform,
      });
      results.push({ platform: target.platform, error: err.message });
    }
  }

  const after = getPost(postId);
  const allDone = after.targets.every((t) => t.status === 'published');
  const anyDone = after.targets.some((t) => t.status === 'published');
  const status = allDone ? 'published' : anyDone ? 'partial' : 'failed';
  db.prepare("UPDATE posts SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, postId);

  return { status, results };
}

function markFailed(target, message) {
  db.prepare("UPDATE post_targets SET status = 'failed', error = ? WHERE id = ?").run(message, target.id);
}
