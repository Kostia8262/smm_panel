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
const { workerHeartbeat } = await import('../journal.js');
const { checkUpcomingAudio } = await import('../audio.js');
const { audioInfo } = await import('../platforms/instagram-audio.js');
const { collectTrendingSounds } = await import('../trends/sounds.js');
const { collectAccounts } = await import('../trends/accounts.js');
const { credentialsFor, listProjects } = await import('../projects.js');
const { getSetting, setSetting } = await import('../staff.js');

const TICK_MS = Number(process.env.WORKER_TICK_MS || 60000);
const SWEEP_MS = 3600 * 1000;
const ORPHAN_AGE_MS = 3 * 3600 * 1000;
const PURGE_MS = 10 * 60 * 1000;
const TOKENS_MS = Number(process.env.TOKEN_SWEEP_MS || 6 * 3600 * 1000);
/**
 * Сколько постов публикуется одновременно.
 *
 * До 13.09.2026 — строго один: Reels в трёх сетях держал очередь полчаса, и
 * пост, назначенный на 10:00, выходил в 10:30. Публикация — это ожидание
 * ответов Graph API, а не работа процессора, так что параллель ядро VPS не
 * нагружает. Больше трёх незачем: у аккаунтов суточные лимиты, а не поток.
 */
const PARALLEL = Math.max(1, Number(process.env.WORKER_PARALLEL || 3));
/** Посты, которые публикуются прямо сейчас, — их разбор зависших не трогает. */
const inFlight = new Set();
let busy = false;
let sweptAt = 0;
let purgedAt = 0;
let quotaWarned = false;
let tokensAt = 0;
let tokensBusy = false;
const AUDIO_MS = 3600 * 1000;
const SOUNDS_MS = 24 * 3600 * 1000;
let audioAt = 0;
let audioBusy = false;

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
  }
  // Ящики рассылки — тем же обходом: у них та же беда, доступ умирает молча
  // (смена пароля Google, отзыв в аккаунте, режим Testing).
  try {
    const { sweepSenders } = await import('../mail/sender/senders.js');
    await sweepSenders();
  } catch (err) {
    log('warn', `рассылка: сторож ящиков не отработал: ${err.message}`);
  } finally {
    tokensBusy = false;
  }
}

/**
 * Звук Instagram: раз в час — не пропал ли трек у постов ближайших двух суток
 * (src/audio.js), раз в сутки — трендовые звуки и аккаунты, за которыми
 * следим (src/trends/accounts.js), на доску трендов.
 *
 * Трек выбирают за дни до выхода, а библиотека меняется: без проверки пост
 * упал бы в момент публикации, когда выбрать другой звук уже некогда. Отметка
 * о последнем сборе трендов лежит в базе, а не в памяти: иначе каждая выкатка
 * с перезапуском воркера дёргала бы Instagram заново.
 */
async function watchAudio() {
  if (audioBusy || Date.now() - audioAt < AUDIO_MS) return;
  audioBusy = true;
  audioAt = Date.now();
  try {
    await checkUpcomingAudio({
      db,
      log,
      fetchInfo: (audioId, projectId) => audioInfo(audioId, credentialsFor(projectId, 'instagram')),
    });

    const last = Number(getSetting('sounds_collected_at', '0')) || 0;
    if (Date.now() - last >= SOUNDS_MS) {
      setSetting('sounds_collected_at', String(Date.now()));
      for (const project of listProjects()) {
        const creds = credentialsFor(project.id, 'instagram');
        if (!creds.userId || !creds.pageToken) continue;
        try {
          await collectTrendingSounds(project.id);
        } catch (err) {
          log('warn', `сбор трендов, звуки Instagram «${project.title}»: ${err.message}`);
        }
        // Аккаунты, за которыми следим, — тем же суточным обходом: у чужих
        // аккаунтов цифры за час не меняются, а запросы Business Discovery
        // идут в тот же лимит, что и публикация.
        try {
          await collectAccounts(project.id);
        } catch (err) {
          log('warn', `сбор трендов, аккаунты «${project.title}»: ${err.message}`);
        }
      }
    }
  } catch (err) {
    log('warn', `сторож звука не отработал: ${err.message}`);
  } finally {
    audioBusy = false;
  }
}

async function tick() {
  // Отметка до проверки `busy`: воркер, занятый выгрузкой видео, жив, и
  // журнал не должен рисовать его молчащим. Упавшая отметка не повод
  // пропускать публикацию.
  try {
    workerHeartbeat(TICK_MS);
  } catch (err) {
    console.error(`[worker] отметка не записалась: ${err.message}`);
  }
  // Сам обход короткий: публикации запускаются без ожидания и живут в
  // `inFlight`, так что второй заход в него же не нужен и не опасен.
  if (busy) return;
  busy = true;
  try {
    // Разбор зависших идёт каждый тик, а не только при старте: процесс может
    // умереть и в середине дня, а пост с неизвестной судьбой должен всплыть
    // в панели через четверть часа, а не после следующей перезагрузки.
    // Идущие публикации этого процесса — не зависшие, их не трогаем.
    recoverStuck(db, log, { busyPostIds: inFlight });
    sweep();
    purge();
    // Намеренно без await: обход площадок не должен задерживать созревшие
    // посты — иначе медленный Graph API отодвигает публикацию по времени.
    watchTokens();
    watchAudio();

    const due = db.prepare(dueQuery()).all().filter((post) => !inFlight.has(post.id));

    for (const post of due) {
      if (inFlight.size >= PARALLEL) break;
      // Время в базе местное и без зоны. Приписка 'Z' объявляла его UTC и
      // сдвигала опоздание на часовой пояс — в Киеве летом на три часа.
      const lateMin = Math.round(
        (Date.now() - new Date(post.scheduled_at.replace(' ', 'T')).getTime()) / 60000
      );
      if (lateMin > 15) {
        log('warn', `пост #${post.id} уходит с опозданием на ${lateMin} мин`, { postId: post.id });
      }
      launch(post.id);
    }
  } catch (err) {
    log('error', `воркер споткнулся: ${err.message}`);
  } finally {
    busy = false;
  }
}

/**
 * Запустить публикацию, не дожидаясь её.
 *
 * Статус `publishing` пост получает синхронно, в самом начале `publishPost`, —
 * до первого обращения к сети. Поэтому следующий обход его уже не выберет.
 * Освободилось место — сразу смотрим очередь, а не ждём минуту до тика.
 */
function launch(postId) {
  inFlight.add(postId);
  publishPost(postId)
    .catch((err) => log('error', `публикация поста #${postId} споткнулась: ${err.message}`, { postId }))
    .finally(() => {
      inFlight.delete(postId);
      setImmediate(tick);
    });
}

/**
 * Рассылка писем (src/mail/runner.js) — свой частый цикл и свой флаг
 * занятости: пауза между письмами — секунды, и ждать минутного тика постов
 * значило бы слать по письму в минуту. Долгая выгрузка видео письма не держит,
 * и наоборот. Одна и та же ошибка пишется в журнал раз в десять минут, а не
 * каждые пять секунд.
 */
const MAIL_TICK_MS = Number(process.env.MAIL_TICK_MS || 5000);
let mailBusy = false;
let mailError = { text: '', at: 0 };
async function mailTick() {
  if (mailBusy) return;
  mailBusy = true;
  try {
    const { mailStep } = await import('../mail/runner.js');
    await mailStep();
  } catch (err) {
    if (err.message !== mailError.text || Date.now() - mailError.at > 10 * 60 * 1000) {
      log('warn', `рассылка: отправщик споткнулся: ${err.message}`);
      mailError = { text: err.message, at: Date.now() };
    }
  } finally {
    mailBusy = false;
  }
}

log('info', `воркер запущен, тик ${TICK_MS / 1000} с`);
recoverStuck(db, log);
tick();
setInterval(tick, TICK_MS);
setInterval(mailTick, MAIL_TICK_MS);
