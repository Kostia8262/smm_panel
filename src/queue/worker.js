/**
 * Воркер очереди: раз в минуту забирает созревшие посты и публикует.
 *
 * Отдельным процессом от веб-морды — чтобы долгая выгрузка видео не держала
 * интерфейс. Оба процесса под PM2, база одна.
 *
 * Опоздание допускается: если сервис лежал, пост уйдёт при первом же тике
 * после подъёма. Молча пропускать пропущенное время нельзя — это как раз тот
 * случай, когда «не опубликовалось и никто не заметил».
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { db, log } = await import('../db.js');
const { publishPost } = await import('./publish.js');

const TICK_MS = Number(process.env.WORKER_TICK_MS || 60000);
let busy = false;

async function tick() {
  if (busy) return; // публикация может идти дольше минуты — второй заход не нужен
  busy = true;
  try {
    const due = db
      .prepare(
        `SELECT id, scheduled_at FROM posts
         WHERE status IN ('scheduled', 'partial')
           AND scheduled_at IS NOT NULL
           AND datetime(scheduled_at) <= datetime('now')
         ORDER BY scheduled_at
         LIMIT 5`
      )
      .all();

    for (const post of due) {
      const lateMin = Math.round(
        (Date.now() - new Date(post.scheduled_at + 'Z').getTime()) / 60000
      );
      if (lateMin > 15) {
        log('warn', `пост #${post.id} уходит с опозданием на ${lateMin} мин`, { postId: post.id });
      }
      await publishPost(post.id);
    }
  } catch (err) {
    log('error', `воркер споткнулся: ${err.message}`);
  } finally {
    busy = false;
  }
}

log('info', `воркер запущен, тик ${TICK_MS / 1000} с`);
tick();
setInterval(tick, TICK_MS);
