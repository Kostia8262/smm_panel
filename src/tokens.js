/**
 * Сторож токенов площадок.
 *
 * Главный записанный риск проекта: токен умирает молча. Постинг не падает с
 * грохотом — он просто перестаёт происходить, и заметно это становится через
 * неделю, когда владелец спрашивает, почему в Threads тишина.
 *
 * Смертей у токена две, и ловятся они по-разному:
 *
 *   1. Срок. Токен Threads живёт 60 дней, токен страницы Facebook — столько
 *      же, если выпущен от личного аккаунта. Это предсказуемо: дату можно
 *      узнать заранее и предупредить за две недели.
 *   2. Отзыв. Владелец сменил пароль Facebook, разлогинился везде, отобрал
 *      права приложению — токен умирает в тот же миг, и никакая дата этого
 *      не предскажет. Ловится только живой проверкой.
 *
 * Поэтому сторож делает и то, и другое: дёргает `check()` каждой подключённой
 * площадки и, где умеет, читает срок. Молчание в журнале означает, что всё
 * проверено, а не что проверять было нечем.
 *
 * Писем он не шлёт: почты у панели нет, заводить ради этого SMTP — лишняя
 * зависимость и лишний секрет на сервере. Предупреждение живёт в журнале и
 * в интерфейсе, у владельца на виду.
 */

import { db, log } from './db.js';
import { getAdapter } from './platforms/index.js';
import * as facebook from './platforms/facebook.js';
import { listProjects, credentialsFor, accountSavedAt } from './projects.js';

/**
 * Что известно про срок жизни у каждой площадки.
 *
 *   read     — срок можно спросить у площадки, это факт;
 *   estimate — спросить негде, считаем от дня, когда токен вписали в панель;
 *   none     — срока нет вовсе, сторожим только живость;
 *   unknown  — площадка ещё не заведена, гадать не о чем.
 */
export const TOKEN_POLICY = {
  telegram: { kind: 'none', why: 'Токен бота не протухает — его можно только отозвать у @BotFather' },
  threads: {
    kind: 'estimate',
    days: 60,
    why: 'Threads не отдаёт срок ни одним вызовом — считаем 60 дней от дня, когда токен вписали',
  },
  instagram: { kind: 'read', why: 'Тот же токен страницы, что у Facebook — срок читается через debug_token' },
  facebook: { kind: 'read', why: 'Срок читается через debug_token; у системного пользователя его нет вовсе' },
  tiktok: { kind: 'unknown', why: 'Площадка ещё не подключена' },
};

/**
 * За сколько дней до смерти начинать беспокоить и насколько громко.
 *
 * Стадии «0» здесь нет намеренно: пока остался хотя бы неполный день, токен
 * работает, и говорить «истёк» про живой токен — значит однажды приучить
 * владельца не верить плашке. Истёкший разбирается отдельно, в `tokenState`.
 */
const STAGES = [
  { stage: '3', within: 3, level: 'error', word: 'умрёт со дня на день' },
  { stage: '7', within: 7, level: 'warn', word: 'умрёт на этой неделе' },
  { stage: '14', within: 14, level: 'warn', word: 'умрёт через две недели' },
];

export const DAY_MS = 86400000;

/**
 * Сколько дней осталось. Считаем по целым дням: «осталось 0» означает
 * «сегодня последний», а не «уже поздно» — разница видна человеку.
 */
export function daysLeft(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / DAY_MS);
}

/**
 * Состояние токена одной площадки. Чистая функция — от неё зависит и цвет
 * плашки в панели, и то, напишет ли сторож в журнал.
 *
 * @returns {{state: 'ok'|'soon'|'expired'|'broken'|'unknown', stage: string|null, left: number|null}}
 */
export function tokenState({ expiresAt = null, error = null } = {}, now = new Date()) {
  // Мёртвый токен важнее любого срока: он уже не работает, независимо от даты.
  if (error) return { state: 'broken', stage: 'broken', left: null };

  const left = daysLeft(expiresAt, now);
  if (left === null) return { state: 'ok', stage: null, left: null };
  if (left < 0) return { state: 'expired', stage: 'expired', left };

  const hit = STAGES.filter((s) => left <= s.within).sort((a, b) => a.within - b.within)[0];
  return hit ? { state: 'soon', stage: hit.stage, left } : { state: 'ok', stage: null, left };
}

/** Стадия тревоги ухудшилась? Только тогда стоит снова писать в журнал. */
export function stageWorsened(previous, current) {
  if (!current) return false;
  if (!previous) return true;
  if (previous === current) return false;
  const order = ['14', '7', '3', 'expired', 'broken'];
  return order.indexOf(current) > order.indexOf(previous);
}

/* ------------------------------- опрос ------------------------------- */

/**
 * Срок жизни токена площадки. Возвращает `{expiresAt, estimated}`.
 *
 * У Instagram свой токен не выпускается — это тот же токен страницы, что у
 * Facebook, и спросить про него можно только приложением, чьи `appId` и
 * `appSecret` лежат в карточке Facebook того же проекта. Отсюда заглядывание
 * в чужие доступы: без него Instagram остался бы без срока на ровном месте.
 */
export async function readExpiry(projectId, platform, creds) {
  const policy = TOKEN_POLICY[platform] || { kind: 'unknown' };

  if (policy.kind === 'none' || policy.kind === 'unknown') {
    return { expiresAt: null, estimated: false };
  }

  if (policy.kind === 'estimate') {
    const savedAt = accountSavedAt(projectId, platform);
    if (!savedAt) return { expiresAt: null, estimated: false };
    // Приписка 'Z' здесь верна, в отличие от времени постов: `updated_at`
    // пишется через `datetime('now')`, а это по определению UTC. У постов
    // время местное, и такая же приписка там однажды сдвинула публикацию
    // на три часа — не переносить отсюда туда и наоборот.
    const at = new Date(new Date(savedAt.replace(' ', 'T') + 'Z').getTime() + policy.days * DAY_MS);
    return { expiresAt: at.toISOString(), estimated: true };
  }

  const app =
    platform === 'facebook' ? creds : { ...creds, ...pickAppKeys(credentialsFor(projectId, 'facebook')) };
  if (!app.appId || !app.appSecret) {
    // Без ключей приложения debug_token не ответит. Это не поломка токена —
    // просто нечем спросить, и врать «бессрочный» тут нельзя.
    return { expiresAt: null, estimated: false, unreadable: 'не заполнены ID и секрет приложения' };
  }

  const expiresAt = await facebook.tokenExpiry({
    appId: app.appId,
    appSecret: app.appSecret,
    pageToken: creds.pageToken,
  });
  return { expiresAt, estimated: false };
}

function pickAppKeys(creds = {}) {
  return { appId: creds.appId, appSecret: creds.appSecret };
}

/**
 * Проверить одну площадку одного проекта: жив ли токен и когда умрёт.
 * Ничего не пишет в базу — это делает `sweepTokens`.
 */
export async function inspectToken(projectId, platform) {
  const adapter = getAdapter(platform);
  const creds = credentialsFor(projectId, platform);
  if (!adapter.isConfigured(creds)) return null; // не подключено — и сторожить нечего

  const out = { projectId, platform, account: '', error: null, expiresAt: null, estimated: false };

  try {
    const res = await adapter.check(creds);
    out.account = res.account || res.chat || res.bot || '';
  } catch (err) {
    out.error = err.message;
    return out; // мёртвый токен срока не отдаст, спрашивать бессмысленно
  }

  try {
    const { expiresAt, estimated, unreadable } = await readExpiry(projectId, platform, creds);
    out.expiresAt = expiresAt;
    out.estimated = Boolean(estimated);
    if (unreadable) out.unreadable = unreadable;
  } catch (err) {
    // Связь есть, а срок не прочитался: это не смерть токена, и поднимать
    // тревогу нельзя — иначе рабочая площадка красится в красное из-за
    // чужой ошибки в debug_token.
    out.unreadable = err.message;
  }

  return out;
}

/* ------------------------------- хранение ------------------------------- */

export function saveHealth(row, now = new Date()) {
  const { state, stage } = tokenState(row, now);
  const previous = db
    .prepare('SELECT warned_stage FROM token_health WHERE project_id = ? AND platform = ?')
    .get(row.projectId, row.platform);

  const worsened = stageWorsened(previous?.warned_stage || null, stage);
  // Стадию помним только пока беда есть: починили токен — забыли, чтобы
  // следующая беда снова прозвучала.
  const warnedStage = stage ? (worsened ? stage : previous?.warned_stage || stage) : null;

  db.prepare(
    `INSERT INTO token_health (project_id, platform, expires_at, estimated, state, account,
                               checked_at, last_error, warned_stage)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
     ON CONFLICT(project_id, platform) DO UPDATE SET
       expires_at = excluded.expires_at,
       estimated = excluded.estimated,
       state = excluded.state,
       account = excluded.account,
       checked_at = excluded.checked_at,
       last_error = excluded.last_error,
       warned_stage = excluded.warned_stage`
  ).run(
    row.projectId,
    row.platform,
    // `undefined` SQLite не принимает вовсе, а прийти оно может от площадки,
    // у которой срока нет: подставляем NULL, а не роняем обход целиком.
    row.expiresAt ?? null,
    row.estimated ? 1 : 0,
    state,
    row.account || '',
    row.error || row.unreadable || null,
    warnedStage
  );

  return { state, stage, worsened };
}

/**
 * Обойти все подключения всех проектов.
 *
 * Идёт по одному: площадок с проектами десятка полтора, спешить некуда, а
 * пачка одновременных запросов к Graph API — верный способ поймать лимит
 * ровно в тот момент, когда должен уходить пост.
 */
export async function sweepTokens({ now = new Date() } = {}) {
  const projects = listProjects();
  const checked = [];

  for (const project of projects) {
    for (const platform of Object.keys(TOKEN_POLICY)) {
      let row;
      try {
        row = await inspectToken(project.id, platform);
      } catch (err) {
        log('warn', `сторож токенов споткнулся на ${platform}: ${err.message}`, { platform });
        continue;
      }
      if (!row) continue;

      const { state, stage, worsened } = saveHealth(row, now);
      checked.push({ ...row, state, stage });

      if (!worsened) continue;

      if (state === 'broken') {
        log('error', `${project.title}: ${platform} не отвечает на проверку — ${row.error}`, {
          platform,
        });
      } else if (state === 'expired') {
        log('error', `${project.title}: токен ${platform} истёк — публикация туда не уйдёт`, {
          platform,
        });
      } else {
        const left = daysLeft(row.expiresAt, now);
        const word = STAGES.find((s) => s.stage === stage)?.word || 'скоро истечёт';
        const level = STAGES.find((s) => s.stage === stage)?.level || 'warn';
        const guess = row.estimated ? ' (срок посчитан, а не прочитан у площадки)' : '';
        log(
          level,
          `${project.title}: токен ${platform} ${word} — осталось дней: ${left}${guess}`,
          { platform }
        );
      }
    }
  }

  log('info', `сторож токенов проверил подключений: ${checked.length}`);
  return checked;
}

/* ------------------------------- для панели ------------------------------- */

/** Всё, что сторож знает, — в том виде, в каком это рисует карточка проекта. */
export function tokenHealth({ projectId = null } = {}) {
  const rows = projectId
    ? db.prepare('SELECT * FROM token_health WHERE project_id = ?').all(projectId)
    : db.prepare('SELECT * FROM token_health').all();

  return rows.map((r) => ({
    projectId: r.project_id,
    platform: r.platform,
    state: r.state,
    expiresAt: r.expires_at,
    estimated: Boolean(r.estimated),
    left: daysLeft(r.expires_at),
    account: r.account,
    checkedAt: r.checked_at,
    error: r.last_error,
    why: TOKEN_POLICY[r.platform]?.why || '',
  }));
}

/**
 * Есть ли о чём кричать. Отсюда берётся точка у раздела «Проекты»: владелец
 * сидит в календаре и о смерти токена иначе не узнает.
 */
export function tokenAlerts() {
  const bad = tokenHealth().filter((t) => t.state !== 'ok' && t.state !== 'unknown');
  return {
    count: bad.length,
    worst: bad.some((t) => t.state === 'expired' || t.state === 'broken') ? 'danger' : bad.length ? 'warn' : null,
    items: bad,
  };
}
