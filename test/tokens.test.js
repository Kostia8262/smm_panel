/**
 * Проверки сторожа токенов.
 *
 * Сторож нужен ровно потому, что его отсутствие не видно: постинг встаёт
 * молча. Значит и сломаться он может молча — отсюда тесты на три вещи, без
 * которых он бесполезен:
 *   — тревога поднимается заранее, а не в день смерти;
 *   — одно и то же предупреждение не повторяется каждые шесть часов, иначе
 *     журнал перестают читать, и настоящая беда тонет в шуме;
 *   — вписанный заново токен снимает старую тревогу сразу, не дожидаясь
 *     следующего обхода.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'smm-tokens-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SECRET_KEY_PATH = join(dir, 'test.key');

const { db } = await import('../src/db.js');
const projects = await import('../src/projects.js');
const {
  tokenState,
  stageWorsened,
  daysLeft,
  saveHealth,
  tokenHealth,
  tokenAlerts,
  readExpiry,
  renewToken,
  canRenew,
  sweepTokens,
  RENEW_BEFORE_DAYS,
  DAY_MS,
} = await import('../src/tokens.js');

const NOW = new Date('2026-09-12T10:00:00Z');
let projectId;

before(() => {
  projectId = projects.createProject({ slug: 'watch', title: 'Сторожевая' }).id;
});

function inDays(n) {
  return new Date(NOW.getTime() + n * DAY_MS).toISOString();
}

/* ------------------------------- пороги ------------------------------- */

test('бессрочный токен тревоги не поднимает', () => {
  const res = tokenState({ expiresAt: null }, NOW);
  assert.equal(res.state, 'ok');
  assert.equal(res.stage, null);
});

test('за месяц до смерти сторож молчит, за две недели — говорит', () => {
  assert.equal(tokenState({ expiresAt: inDays(30) }, NOW).state, 'ok');

  const soon = tokenState({ expiresAt: inDays(13) }, NOW);
  assert.equal(soon.state, 'soon');
  assert.equal(soon.stage, '14');
});

test('чем ближе смерть, тем выше стадия', () => {
  assert.equal(tokenState({ expiresAt: inDays(6) }, NOW).stage, '7');
  assert.equal(tokenState({ expiresAt: inDays(2) }, NOW).stage, '3');
  // Последний день — ещё не «поздно»: токен сегодня работает.
  assert.equal(tokenState({ expiresAt: inDays(0.5) }, NOW).stage, '3');
});

test('просроченный и отозванный различаются', () => {
  assert.equal(tokenState({ expiresAt: inDays(-1) }, NOW).state, 'expired');

  // Отзыв: дата ещё не пришла, а площадка уже не пускает. Это и есть смена
  // пароля владельцем — случай, который никакой датой не предсказать.
  const revoked = tokenState({ expiresAt: inDays(40), error: 'Session has expired' }, NOW);
  assert.equal(revoked.state, 'broken');
});

test('дни считаются вниз, а не округляются вверх', () => {
  assert.equal(daysLeft(inDays(1.9), NOW), 1);
  assert.equal(daysLeft(null, NOW), null);
});

/* --------------------------- повторные тревоги --------------------------- */

test('стадия растёт только вверх', () => {
  assert.equal(stageWorsened(null, '14'), true);
  assert.equal(stageWorsened('14', '14'), false);
  assert.equal(stageWorsened('14', '7'), true);
  assert.equal(stageWorsened('7', '14'), false); // назад не откатываемся
  assert.equal(stageWorsened('7', 'broken'), true);
  assert.equal(stageWorsened('7', null), false); // починили — молчим
});

test('одно и то же предупреждение не повторяется каждый обход', () => {
  const row = { projectId, platform: 'threads', expiresAt: inDays(10), estimated: true };

  const first = saveHealth(row, NOW);
  assert.equal(first.stage, '14');
  assert.equal(first.worsened, true, 'первый раз сказать надо');

  const second = saveHealth(row, NOW);
  assert.equal(second.worsened, false, 'второй раз — молча');

  // А вот когда стало хуже — снова вслух.
  const worse = saveHealth({ ...row, expiresAt: inDays(5) }, NOW);
  assert.equal(worse.stage, '7');
  assert.equal(worse.worsened, true);
});

test('починенный токен забывает свою стадию', () => {
  saveHealth({ projectId, platform: 'facebook', expiresAt: inDays(2) }, NOW);
  saveHealth({ projectId, platform: 'facebook', expiresAt: null }, NOW);

  const row = tokenHealth({ projectId }).find((t) => t.platform === 'facebook');
  assert.equal(row.state, 'ok');

  // Если беда вернётся, о ней скажут заново, а не «уже предупреждали».
  const again = saveHealth({ projectId, platform: 'facebook', expiresAt: inDays(2) }, NOW);
  assert.equal(again.worsened, true);
});

test('в тревогу попадает только сломанное', () => {
  saveHealth({ projectId, platform: 'telegram', expiresAt: null }, NOW);
  saveHealth({ projectId, platform: 'instagram', error: 'токен отозван' }, NOW);

  const alerts = tokenAlerts();
  const platforms = alerts.items.map((i) => i.platform);
  assert.ok(!platforms.includes('telegram'), 'здоровый токен в тревоге не нужен');
  assert.ok(platforms.includes('instagram'));
  assert.equal(alerts.worst, 'danger', 'отозванный токен — это красное, а не жёлтое');
});

/* ------------------------------ срок Threads ------------------------------ */

test('у Threads срок считается от дня, когда токен вписали', async () => {
  projects.saveAccount(projectId, 'threads', { userId: '1', accessToken: 'x'.repeat(20) });

  const { expiresAt, estimated } = await readExpiry(projectId, 'threads', {});
  assert.ok(expiresAt, 'срок должен появиться');
  assert.equal(estimated, true, 'это расчёт, а не факт от площадки — и панель обязана это показать');

  const left = daysLeft(expiresAt, new Date());
  assert.ok(left >= 58 && left <= 60, `ожидались ~60 дней, получено ${left}`);
});

test('новый токен снимает старую тревогу сразу', () => {
  saveHealth({ projectId, platform: 'threads', expiresAt: inDays(-5) }, NOW);
  assert.ok(tokenHealth({ projectId }).some((t) => t.platform === 'threads' && t.state === 'expired'));

  projects.saveAccount(projectId, 'threads', { userId: '1', accessToken: 'y'.repeat(20) });

  const left = tokenHealth({ projectId }).find((t) => t.platform === 'threads');
  assert.equal(left, undefined, 'отметка сторожа должна уйти вместе со старым токеном');
});

test('без ключей приложения срок Facebook честно остаётся неизвестным', async () => {
  const res = await readExpiry(projectId, 'facebook', { pageId: '1', pageToken: 'z'.repeat(20) });
  assert.equal(res.expiresAt, null);
  assert.ok(res.unreadable, 'нечитаемый срок должен объясняться, а не выглядеть бессрочным');

  // Главное: это не тревога. Рабочая площадка не краснеет из-за того, что
  // мы не смогли спросить про её срок.
  const state = tokenState({ expiresAt: null }, NOW);
  assert.equal(state.state, 'ok');
});

test('база не хранит отметки об удалённом проекте', () => {
  const temp = projects.createProject({ slug: 'gone', title: 'Уходящая' }).id;
  saveHealth({ projectId: temp, platform: 'telegram', expiresAt: null }, NOW);
  db.prepare('DELETE FROM projects WHERE id = ?').run(temp);
  assert.equal(tokenHealth({ projectId: temp }).length, 0);
});


/* ------------------------------- продление ------------------------------- */

/**
 * Подменяем сеть целиком: в тестах ходить в Threads нельзя, а весь смысл
 * продления — именно в том, что и как отвечает площадка.
 */
const realFetch = globalThis.fetch;

function fakeThreads({ refresh = null, checkFails = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);

    if (href.includes('refresh_access_token')) {
      if (refresh?.error) {
        return { ok: false, json: async () => ({ error: { message: refresh.error } }) };
      }
      return { ok: true, json: async () => refresh };
    }
    if (checkFails) {
      return { ok: false, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) };
    }
    return { ok: true, json: async () => ({ id: '1', username: 'academy' }) };
  };
  return calls;
}

test('Threads умеет продлевать себя, Facebook — нет', () => {
  assert.equal(canRenew('threads'), true);
  // У Facebook токен страницы меняется не панелью, а выпуском от системного
  // пользователя: кнопка «продлить» тут обманывала бы.
  assert.equal(canRenew('facebook'), false);
  assert.equal(canRenew('telegram'), false);
});

test('продление записывает новый токен и точный срок от площадки', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  fakeThreads({ refresh: { access_token: 'new-token-'.padEnd(30, 'z'), expires_in: 5183944 } });

  projects.saveAccount(projectId, 'threads', { userId: '7', accessToken: 'old'.padEnd(30, 'o') });
  const { expiresAt } = await renewToken(projectId, 'threads');

  const creds = projects.credentialsFor(projectId, 'threads');
  assert.match(creds.accessToken, /^new-token-/, 'в карточке должен лежать новый токен');
  assert.equal(creds.userId, '7', 'остальные поля продление не трогает');

  const left = daysLeft(expiresAt, new Date());
  assert.ok(left >= 58 && left <= 60, `ожидались ~60 дней, получено ${left}`);

  const row = tokenHealth({ projectId }).find((t2) => t2.platform === 'threads');
  assert.equal(row.state, 'ok');
  assert.equal(row.estimated, false, 'срок от площадки — факт, а не расчёт');
});

test('площадка без нового токена в ответе — это ошибка, а не тихий успех', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  fakeThreads({ refresh: { token_type: 'bearer', expires_in: 5183944 } });

  projects.saveAccount(projectId, 'threads', { userId: '7', accessToken: 'keep'.padEnd(30, 'k') });
  await assert.rejects(() => renewToken(projectId, 'threads'), /не вернула новый токен/);

  const creds = projects.credentialsFor(projectId, 'threads');
  assert.match(creds.accessToken, /^keep/, 'старый токен обязан уцелеть');
});

test('сторож продлевает сам, когда срок подошёл', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeThreads({ refresh: { access_token: 'auto'.padEnd(30, 'a'), expires_in: 5183944 } });

  // Токен, вписанный 50 дней назад: по расчёту ему остаётся 10 дней.
  projects.saveAccount(projectId, 'threads', { userId: '7', accessToken: 'aging'.padEnd(30, 'g') });
  db.prepare(
    "UPDATE project_accounts SET updated_at = datetime('now', '-50 days') WHERE project_id = ? AND platform = 'threads'"
  ).run(projectId);

  await sweepTokens();

  assert.ok(
    calls.some((c) => c.includes('refresh_access_token')),
    'сторож обязан был сходить за продлением'
  );
  const creds = projects.credentialsFor(projectId, 'threads');
  assert.match(creds.accessToken, /^auto/, 'новый токен должен оказаться в карточке');

  const row = tokenHealth({ projectId }).find((t2) => t2.platform === 'threads');
  assert.equal(row.state, 'ok', 'после продления тревоги быть не должно');
});

test('свежий токен сторож не трогает', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeThreads({ refresh: { access_token: 'nope'.padEnd(30, 'n'), expires_in: 5183944 } });

  projects.saveAccount(projectId, 'threads', { userId: '7', accessToken: 'fresh'.padEnd(30, 'f') });
  await sweepTokens();

  assert.ok(
    !calls.some((c) => c.includes('refresh_access_token')),
    `продление за ${RENEW_BEFORE_DAYS} дней, а не при каждом обходе`
  );
});

test('неудачное продление оставляет тревогу, а не гасит её', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  fakeThreads({ refresh: { error: 'The session has been invalidated' } });

  projects.saveAccount(projectId, 'threads', { userId: '7', accessToken: 'doomed'.padEnd(30, 'd') });
  db.prepare(
    "UPDATE project_accounts SET updated_at = datetime('now', '-52 days') WHERE project_id = ? AND platform = 'threads'"
  ).run(projectId);

  await sweepTokens();

  const row = tokenHealth({ projectId }).find((t2) => t2.platform === 'threads');
  assert.equal(row.state, 'soon', 'сторож не сумел — значит человек должен увидеть беду');
  assert.ok(row.left <= 14);
});

test('мёртвый токен продлевать не пытаемся', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = fakeThreads({ checkFails: true, refresh: { access_token: 'x', expires_in: 100 } });

  projects.saveAccount(projectId, 'threads', { userId: '7', accessToken: 'dead'.padEnd(30, 'x') });
  db.prepare(
    "UPDATE project_accounts SET updated_at = datetime('now', '-55 days') WHERE project_id = ? AND platform = 'threads'"
  ).run(projectId);

  await sweepTokens();

  // Продлевать нечего: площадка на такой запрос ответит ошибкой, и в журнале
  // она ляжет поверх настоящей — отозванного доступа.
  assert.ok(!calls.some((c) => c.includes('refresh_access_token')));
  const row = tokenHealth({ projectId }).find((t2) => t2.platform === 'threads');
  assert.equal(row.state, 'broken');
});
