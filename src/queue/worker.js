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
const { sweepOrphans, THUMB_DIR } = await import('../media.js');
const { sweepTokens } = await import('../tokens.js');
const { purgePublishedMedia, quotaCheck } = await import('../retention.js');

const TICK_MS = Number(process.env.WORKER_TICK_MS || 60000);
const SWEEP_MS = 3600 * 1000;
const ORPHAN_AGE_MS = 3 * 3600 * 1000;
const PURGE_MS = 10 * 60 * 1000;
const TOKENS_MS = Number(process.env.TOKEN_SWEEP_MS || 6 * 3600 * 1000);
let busy = false;
let sweptAt = 0;
let purgedAt = 0;
let quotaWarned = false;
let tokensAt = 0;
let tokensBusy = false;

/**
 * Подмести файлы, на которые в базе уже никто не ссылается.
 *
 * Место здесь, а не в веб-морде: перебор всего каталога — работа фоновая, и
 * делать её в обработчике запроса значит подвешивать интерфейс тем сильнее,
 * чем больше накопилось. Диск общий с шестнадцатью сайтами сети.
 *
 * Раз в час и старше трёх часов: строка в базе появляется через миллисекунды
 * после записи файла, так что три часа — с огромным запасом на идущую
 * загрузку, а сутки, как было, — просто лишнее место под мусор.
 */
function sweep() {
  if (Date.now() - sweptAt < SWEEP_MS) return;
  sweptAt = Date.now();
  try {
    const keep = new Set(
      db.prepare('SELECT stored_name FROM media').all().map((r) => r.stored_name)
    );
    const removed = sweepOrphans(keep, { olderThanMs: ORPHAN_AGE_MS });
    if (removed) log('info', `убрано файлов без поста: ${removed}`);

    // Миниатюры: своя папка, свой список живых. Сирота здесь — миниатюра,
    // чья загрузка оборвалась, или отклонённая, которую не успели снять.
    const keepThumbs = new Set(
      db.prepare('SELECT thumb_name FROM media WHERE thumb_name IS NOT NULL').all().map((r) => r.thumb_name)
    );
    const removedThumbs = sweepOrphans(keepThumbs, { olderThanMs: ORPHAN_AGE_MS, dir: THUMB_DIR });
    if (removedThumbs) log('info', `убрано миниатюр без поста: ${removedThumbs}`);
  } catch (err) {
    log('warn', `не удалось подмести каталог загрузок: ${err.message}`);
  }
}

/**
 * Снять с диска файлы опубликованных постов (см. retention.js) и приглядеть
 * за квотой.
 *
 * Каждые десять минут — чтобы место освобождалось быстро, как только окно
 * после публикации истекло. Обход дешёвый: один запрос отсекает всё живое.
 *
 * О заполнении квоты говорим один раз на пересечение порога, а не каждые
 * десять минут: иначе предупреждение тонет в собственном повторе.
 */
function purge() {
  if (Date.now() - purgedAt < PURGE_MS) return;
  purgedAt = Date.now();
  try {
    purgePublishedMedia();
    const { used, quota } = quotaCheck(0);
    const high = used > quota * 0.8;
    if (high && !quotaWarned) {
      log('warn', `место под файлы заполнено на ${Math.round((used / quota) * 100)}%: ${Math.round(used / 1048576)} из ${Math.round(quota / 1048576)} МБ`);
    }
    quotaWarned = high;
  } catch (err) {
    log('warn', `не удалось снять файлы опубликованных постов: ${err.message}`);
  }
}

/**
 * Сторож токенов. Место здесь по той же причине, что и подметание файлов:
 * это хождение по внешним API, и делать его в обработчике запроса — значит
 * подвешивать интерфейс на минуту ради служебной проверки.
 *
 * Отдельно от `busy`: публикация может идти дольше шести часов только в
 * страшном сне, но привязывать к ней сторожа незачем — у него своя очередь
 * из одного места, чтобы два обхода не пошли внахлёст.
 */
async function watchTokens() {
  if (tokensBusy || Date.now() - tokensAt < TOKENS_MS) return;
  tokensBusy = true;
  tokensAt = Date.now();
  try {
    await sweepTokens();
  } catch (err) {
    log('warn', `сторож токенов не отработал: ${err.message}`);
  } finally {
    tokensBusy = false;
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
    purge();
    // Намеренно без await: обход площадок не должен задерживать созревшие
    // посты — иначе медленный Graph API отодвигает публикацию по времени.
    watchTokens();

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
