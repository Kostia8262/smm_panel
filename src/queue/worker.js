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
const { recoverStuck, dueQuery } = await import('./recover.js');
const { sweepOrphans } = await import('../media.js');

const TICK_MS = Number(process.env.WORKER_TICK_MS || 60000);
const SWEEP_MS = 6 * 3600 * 1000;
let busy = false;
let sweptAt = 0;

/**
 * Подмести файлы, на которые в базе уже никто не ссылается.
 *
 * Место здесь, а не в веб-морде: перебор всего каталога — работа фоновая, и
 * делать её в обработчике запроса значит подвешивать интерфейс тем сильнее,
 * чем больше накопилось. Диск общий с шестнадцатью сайтами сети, а кадры
 * приходят не тысячами в час — раза в шесть часов достаточно.
 */
function sweep() {
  if (Date.now() - sweptAt < SWEEP_MS) return;
  sweptAt = Date.now();
  try {
    const keep = new Set(
      db.prepare('SELECT stored_name FROM media').all().map((r) => r.stored_name)
    );
    const removed = sweepOrphans(keep);
    if (removed) log('info', `убрано файлов без поста: ${removed}`);
  } catch (err) {
    log('warn', `не удалось подмести каталог загрузок: ${err.message}`);
  }
}

async function tick() {
  if (busy) return; // публикация может идти дольше минуты — второй заход не нужен
  busy = true;
  try {
    // Разбор зависших идёт каждый тик, а не только при старте: процесс может
    // умереть и в середине дня, а пост с неизвестной судьбой должен всплыть
    // в панели через четверть часа, а не после следующей перезагрузки.
    recoverStuck(db, log);
    sweep();

    const due = db.prepare(dueQuery()).all();

    for (const post of due) {
      // Время в базе местное и без зоны. Приписка 'Z' объявляла его UTC и
      // сдвигала опоздание на часовой пояс — в Киеве летом на три часа.
      const lateMin = Math.round(
        (Date.now() - new Date(post.scheduled_at.replace(' ', 'T')).getTime()) / 60000
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
recoverStuck(db, log);
tick();
setInterval(tick, TICK_MS);
