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
import * as threadsAdapter from './platforms/threads.js';
import { listProjects, credentialsFor, tokenSavedAt, saveAccount } from './projects.js';

/**
 * Что известно про срок жизни у каждой площадки.
 *
 *   read     — срок можно спросить у площадки, это факт;
 *   estimate — спросить негде, считаем от дня, когда токен вписали в панель;
 *   none     — срока нет вовсе, сторожим только живость;
 *   unknown  — площадка ещё не заведена, гадать не о чем.
 *
 * `dataAccess` — следить ли за вторым сроком, правилом Meta «90 дней без входа
 * в приложение» (`data_access_expires_at`). Токен может быть бессрочным, а
 * доступ к данным — кончиться; продлевается он входом кнопкой подключения.
 */
export const TOKEN_POLICY = {
  telegram: { kind: 'none', why: 'Токен бота не протухает — его можно только отозвать у @BotFather' },
  threads: {
    // Срок читается у площадки (debug_token, найден 13.09.2026). Если она не
    // ответит — прежний расчёт от дня выпуска, помеченный как догадка.
    kind: 'read',
    fallbackDays: 60,
    dataAccess: true,
    why: 'Срок и доступ к данным читаются через debug_token Threads',
    renew: 'Продлевается сам, за две недели до смерти',
    reconnect: 'Подключить через Threads',
  },
  instagram: {
    kind: 'read',
    // Для прав Instagram документация Meta про правило 90 дней молчит —
    // значит следим: лучше лишнее предупреждение, чем молча вставший постинг.
    dataAccess: true,
    why: 'Тот же токен страницы, что у Facebook — срок читается через debug_token',
    renew: null,
    reconnect: 'Подключить через Facebook',
  },
  facebook: {
    kind: 'read',
    // Права страниц (`pages_*`) документация явно выводит из-под правила 90
    // дней, и предупреждение здесь было бы ложным. Токен общий с Instagram:
    // предупреждение по Instagram покрывает оба, и один вход лечит оба.
    dataAccess: false,
    why: 'Срок читается через debug_token; у системного пользователя его нет вовсе',
    // Обменять истекающий токен страницы можно только на токен пользователя,
    // а его у панели нет и быть не должно. Настоящее решение другое: выпустить
    // токен от системного пользователя в Business Manager — он бессрочный.
    renew: null,
    reconnect: 'Подключить через Facebook',
  },
  tiktok: { kind: 'unknown', why: 'Площадка ещё не подключена' },
};

/**
 * За сколько дней до смерти продлевать самим.
 *
 * Две недели, а не день: продление даёт 60 дней **от дня продления**, а не
 * от старого срока, так что тянуть до последнего нечего не выигрывает. Зато
 * запас в две недели означает, что при первой неудаче остаётся ещё двадцать
 * восемь попыток по полдня — и время, чтобы человек вмешался, если площадка
 * упёрлась всерьёз.
 */
export const RENEW_BEFORE_DAYS = 14;

/** Продление можно выключить — на время разбирательств с площадкой. */
const AUTORENEW = process.env.TOKEN_AUTORENEW !== '0';

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
 * Сроков два — у самого токена и у доступа к данным, — и тревогу поднимает
 * ближайший. `reason` говорит, какой именно: от этого зависит совет, а
 * лечатся они по-разному (продлить токен или войти кнопкой заново).
 *
 * @returns {{state: 'ok'|'soon'|'expired'|'broken'|'unknown', stage: string|null, left: number|null, reason: 'token'|'data'|null}}
 */
export function tokenState({ expiresAt = null, dataAccessAt = null, error = null } = {}, now = new Date()) {
  // Мёртвый токен важнее любого срока: он уже не работает, независимо от даты.
  if (error) return { state: 'broken', stage: 'broken', left: null, reason: null };

  const tokenLeft = daysLeft(expiresAt, now);
  const dataLeft = daysLeft(dataAccessAt, now);
  // При равенстве — токен: его смерть однозначна, а про данные у Meta оговорки.
  const reason = tokenLeft === null && dataLeft === null ? null : dataLeft !== null && (tokenLeft === null || dataLeft < tokenLeft) ? 'data' : 'token';
  const left = reason === 'data' ? dataLeft : tokenLeft;

  if (left === null) return { state: 'ok', stage: null, left: null, reason: null };
  if (left < 0) return { state: 'expired', stage: 'expired', left, reason };

  const hit = STAGES.filter((s) => left <= s.within).sort((a, b) => a.within - b.within)[0];
  return hit ? { state: 'soon', stage: hit.stage, left, reason } : { state: 'ok', stage: null, left, reason };
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
    return { expiresAt: null, estimated: false, dataAccessAt: null };
  }

  if (platform === 'threads') {
    // Сперва — факт от площадки. Сетевой сбой или молчание debug_token не
    // повод остаться без срока вовсе: тогда прежний расчёт, честно помеченный.
    let lifetime = null;
    try {
      lifetime = await threadsAdapter.tokenLifetime(creds);
    } catch {
      lifetime = null;
    }
    if (lifetime) {
      return {
        expiresAt: lifetime.expiresAt,
        estimated: false,
        dataAccessAt: policy.dataAccess ? lifetime.dataAccessExpiresAt : null,
      };
    }
    return { ...estimateFromIssue(projectId, platform, policy.fallbackDays), dataAccessAt: null };
  }

  const app =
    platform === 'facebook' ? creds : { ...creds, ...pickAppKeys(credentialsFor(projectId, 'facebook')) };
  if (!app.appId || !app.appSecret) {
    // Без ключей приложения debug_token не ответит. Это не поломка токена —
    // просто нечем спросить, и врать «бессрочный» тут нельзя.
    return { expiresAt: null, estimated: false, dataAccessAt: null, unreadable: 'не заполнены ID и секрет приложения' };
  }

  const lifetime = await facebook.tokenLifetime({
    appId: app.appId,
    appSecret: app.appSecret,
    pageToken: creds.pageToken,
  });
  return {
    expiresAt: lifetime.expiresAt,
    estimated: false,
    dataAccessAt: policy.dataAccess ? lifetime.dataAccessExpiresAt : null,
  };
}

/**
 * Запасной расчёт срока: от даты выпуска токена, а не от последней правки
 * карточки — поправили id аккаунта, токен от этого моложе не стал.
 */
function estimateFromIssue(projectId, platform, days) {
  const issuedAt = tokenSavedAt(projectId, platform);
  if (!issuedAt || !days) return { expiresAt: null, estimated: false };
  const at = new Date(new Date(issuedAt).getTime() + days * DAY_MS);
  return { expiresAt: at.toISOString(), estimated: true };
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

  const out = { projectId, platform, account: '', error: null, expiresAt: null, estimated: false, dataAccessAt: null };

  try {
    const res = await adapter.check(creds);
    out.account = res.account || res.chat || res.bot || '';
  } catch (err) {
    out.error = err.message;
    return out; // мёртвый токен срока не отдаст, спрашивать бессмысленно
  }

  try {
    const { expiresAt, estimated, dataAccessAt, unreadable } = await readExpiry(projectId, platform, creds);
    out.expiresAt = expiresAt;
    out.estimated = Boolean(estimated);
    out.dataAccessAt = dataAccessAt ?? null;
    if (unreadable) out.unreadable = unreadable;
  } catch (err) {
    // Связь есть, а срок не прочитался: это не смерть токена, и поднимать
    // тревогу нельзя — иначе рабочая площадка красится в красное из-за
    // чужой ошибки в debug_token.
    out.unreadable = err.message;
  }

  return out;
}

/* ------------------------------- продление ------------------------------- */

/** Умеет ли площадка продлевать токен сама. */
export function canRenew(platform) {
  return typeof getAdapter(platform)?.renew === 'function';
}

/**
 * Продлить токен одной площадки и сразу сохранить новый.
 *
 * Порядок здесь важнее красоты: новый токен записывается в карточку проекта
 * первым же действием. Если упасть между «площадка выдала» и «мы сохранили»,
 * новый токен потерян навсегда — в журнал его не напишешь (там ему не место),
 * а старый Threads к тому времени уже считает заменённым.
 */
export async function renewToken(projectId, platform) {
  const adapter = getAdapter(platform);
  if (!adapter.renew) throw new Error(`${platform}: площадка не умеет продлевать токен сама`);

  const creds = credentialsFor(projectId, platform);
  if (!adapter.isConfigured(creds)) throw new Error(`${platform}: доступы не заполнены`);

  const { values, expiresIn } = await adapter.renew(creds);

  // saveAccount заодно снимает отметку сторожа — она относилась к старому
  // токену. Новую пишем следом, уже с точным сроком от площадки.
  saveAccount(projectId, platform, values);

  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
  saveHealth({ projectId, platform, expiresAt, estimated: !expiresIn, account: '' });

  log('info', `токен ${platform} продлён до ${expiresAt ? expiresAt.slice(0, 10) : 'неизвестной даты'}`, {
    platform,
  });
  return { expiresAt };
}

/* ------------------------------- хранение ------------------------------- */

export function saveHealth(row, now = new Date()) {
  const { state, stage, reason } = tokenState(row, now);
  const previous = db
    .prepare('SELECT warned_stage FROM token_health WHERE project_id = ? AND platform = ?')
    .get(row.projectId, row.platform);

  const worsened = stageWorsened(previous?.warned_stage || null, stage);
  // Стадию помним только пока беда есть: починили токен — забыли, чтобы
  // следующая беда снова прозвучала.
  const warnedStage = stage ? (worsened ? stage : previous?.warned_stage || stage) : null;

  db.prepare(
    `INSERT INTO token_health (project_id, platform, expires_at, estimated, state, account,
                               checked_at, last_error, warned_stage, data_access_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)
     ON CONFLICT(project_id, platform) DO UPDATE SET
       expires_at = excluded.expires_at,
       estimated = excluded.estimated,
       state = excluded.state,
       account = excluded.account,
       checked_at = excluded.checked_at,
       last_error = excluded.last_error,
       warned_stage = excluded.warned_stage,
       data_access_at = excluded.data_access_at,
       reason = excluded.reason`
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
    warnedStage,
    row.dataAccessAt ?? null,
    reason
  );

  return { state, stage, worsened, reason };
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

      // Продлеваем до записи тревоги: успешное продление снимает повод для
      // неё, и беспокоить владельца тем, что сторож починил сам, незачем.
      const renewed = await maybeRenew(project, row, now);
      if (renewed) {
        checked.push({ ...renewed, state: 'ok', stage: null });
        continue;
      }

      const { state, stage, worsened, reason } = saveHealth(row, now);
      checked.push({ ...row, state, stage, reason });

      if (!worsened) continue;

      // Доступ к данным лечится не продлением токена, а входом кнопкой — это и
      // пишем, иначе человек пойдёт перевыпускать токен, который в порядке.
      const reconnect = TOKEN_POLICY[platform]?.reconnect;
      const cure = reconnect ? ` Продлевается входом: «Проекты» → «${reconnect}».` : '';

      if (state === 'broken') {
        log('error', `${project.title}: ${platform} не отвечает на проверку — ${row.error}`, {
          platform,
        });
      } else if (state === 'expired' && reason === 'data') {
        log('error', `${project.title}: у ${platform} кончился доступ к данным (правило Meta, 90 дней без входа) — публикация может перестать проходить.${cure}`, {
          platform,
        });
      } else if (state === 'expired') {
        log('error', `${project.title}: токен ${platform} истёк — публикация туда не уйдёт`, {
          platform,
        });
      } else if (reason === 'data') {
        const left = daysLeft(row.dataAccessAt, now);
        const level = STAGES.find((s) => s.stage === stage)?.level || 'warn';
        log(level, `${project.title}: у ${platform} кончается доступ к данным (правило Meta, 90 дней без входа) — осталось дней: ${left}.${cure}`, {
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

/**
 * Продлить, если пора и если площадка умеет.
 *
 * Мёртвый токен не трогаем: продлевать нечего, а площадка на такой запрос
 * отвечает ошибкой, которая в журнале выглядит как новая беда поверх старой.
 * Неудача продления тоже не гасит тревогу — наоборот, о ней говорят вслух:
 * молча не сумевший продлить сторож хуже отсутствующего.
 */
async function maybeRenew(project, row, now) {
  if (!AUTORENEW || row.error || !canRenew(row.platform)) return null;

  const left = daysLeft(row.expiresAt, now);
  if (left === null || left < 0 || left > RENEW_BEFORE_DAYS) return null;

  try {
    const { expiresAt } = await renewToken(project.id, row.platform);
    log('info', `${project.title}: токен ${row.platform} продлён сторожем, было дней: ${left}`, {
      platform: row.platform,
    });
    return { ...row, expiresAt, estimated: false, error: null, renewed: true };
  } catch (err) {
    log('error', `${project.title}: не удалось продлить токен ${row.platform} — ${err.message}`, {
      platform: row.platform,
    });
    return null; // тревога остаётся: продлевать придётся руками
  }
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
    // Дни — по тому сроку, из-за которого поднята тревога; иначе по токену.
    left: daysLeft(r.reason === 'data' ? r.data_access_at : r.expires_at),
    tokenLeft: daysLeft(r.expires_at),
    dataAccessAt: r.data_access_at,
    dataLeft: daysLeft(r.data_access_at),
    reason: r.reason || null,
    reconnect: TOKEN_POLICY[r.platform]?.reconnect || null,
    account: r.account,
    checkedAt: r.checked_at,
    error: r.last_error,
    why: TOKEN_POLICY[r.platform]?.why || '',
    renewable: canRenew(r.platform),
    renewNote: TOKEN_POLICY[r.platform]?.renew || null,
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
