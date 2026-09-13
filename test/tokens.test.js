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

  // Токен, выпущенный 50 дней назад: по расчёту ему остаётся 10 дней.
  projects.saveAccount(projectId, 'threads', { userId: '7', accessToken: 'aging'.padEnd(30, 'g') });
  projects.setTokenSavedAt(projectId, 'threads', new Date(Date.now() - 50 * DAY_MS));

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
  projects.setTokenSavedAt(projectId, 'threads', new Date(Date.now() - 52 * DAY_MS));

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
  projects.setTokenSavedAt(projectId, 'threads', new Date(Date.now() - 55 * DAY_MS));

  await sweepTokens();

  // Продлевать нечего: площадка на такой запрос ответит ошибкой, и в журнале
  // она ляжет поверх настоящей — отозванного доступа.
  assert.ok(!calls.some((c) => c.includes('refresh_access_token')));
  const row = tokenHealth({ projectId }).find((t2) => t2.platform === 'threads');
  assert.equal(row.state, 'broken');
});

/* --------------------------- дата выпуска токена --------------------------- */

test('правка id аккаунта не молодит токен', async () => {
  // Случай 12.09.2026: поправили id аккаунта Threads, и расчётный срок
  // сбросился на «60 дней от сегодня», хотя токен остался прежним.
  projects.saveAccount(projectId, 'threads', { userId: '1', accessToken: 'steady'.padEnd(30, 's') });
  const issued = projects.setTokenSavedAt(projectId, 'threads', new Date(Date.now() - 30 * DAY_MS));

  projects.saveAccount(projectId, 'threads', { userId: '29062313960036757' });

  assert.equal(projects.tokenSavedAt(projectId, 'threads'), issued, 'дата выпуска обязана устоять');
  const { expiresAt } = await readExpiry(projectId, 'threads', {});
  const left = daysLeft(expiresAt, new Date());
  assert.ok(left >= 29 && left <= 30, `ожидалось ~30 дней, получено ${left}`);
});

test('тот же токен, присланный заново, — не новый', () => {
  projects.saveAccount(projectId, 'threads', { userId: '1', accessToken: 'same'.padEnd(30, 'm') });
  const issued = projects.setTokenSavedAt(projectId, 'threads', new Date(Date.now() - 20 * DAY_MS));

  // Форма или скрипт могут прислать уже сохранённое значение целиком.
  projects.saveAccount(projectId, 'threads', { accessToken: 'same'.padEnd(30, 'm') });
  assert.equal(projects.tokenSavedAt(projectId, 'threads'), issued);
});

test('новый токен сдвигает дату выпуска на сегодня', () => {
  projects.saveAccount(projectId, 'threads', { userId: '1', accessToken: 'before'.padEnd(30, 'b') });
  projects.setTokenSavedAt(projectId, 'threads', new Date(Date.now() - 40 * DAY_MS));

  projects.saveAccount(projectId, 'threads', { accessToken: 'after'.padEnd(30, 'a') });

  const age = Date.now() - new Date(projects.tokenSavedAt(projectId, 'threads')).getTime();
  assert.ok(age < 60000, 'дата должна стать сегодняшней');
});

test('дату выпуска нельзя выставить в будущее или мусором', () => {
  projects.saveAccount(projectId, 'threads', { userId: '1', accessToken: 'guard'.padEnd(30, 'u') });

  // Будущая дата подарила бы токену лишние дни — ровно та ошибка, от которой
  // эта дата и заведена.
  assert.throws(() => projects.setTokenSavedAt(projectId, 'threads', new Date(Date.now() + 2 * DAY_MS)), /будущем/);
  assert.throws(() => projects.setTokenSavedAt(projectId, 'threads', 'вчера'), /Не понимаю/);
  assert.throws(() => projects.setTokenSavedAt(projectId, 'tiktok', new Date()), /нет доступов/);
});

test('продление сторожем ставит дату выпуска на день продления', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  fakeThreads({ refresh: { access_token: 'renewed'.padEnd(30, 'r'), expires_in: 5183944 } });

  projects.saveAccount(projectId, 'threads', { userId: '7', accessToken: 'old-one'.padEnd(30, 'o') });
  projects.setTokenSavedAt(projectId, 'threads', new Date(Date.now() - 50 * DAY_MS));

  await renewToken(projectId, 'threads');

  // Иначе следующий обход снова посчитал бы срок от старой даты и продлевал
  // токен при каждом заходе.
  const age = Date.now() - new Date(projects.tokenSavedAt(projectId, 'threads')).getTime();
  assert.ok(age < 60000);
});

/* ---------------------- доступ к данным (правило 90 дней) ---------------------- */

test('бессрочный токен с кончающимся доступом к данным — тревога по данным', () => {
  // Ровно случай 13.09.2026: токены страницы бессрочные, а доступ к данным
  // кончается 12.12 — и сторож об этом молчал.
  const s = tokenState({ expiresAt: null, dataAccessAt: inDays(5) }, NOW);
  assert.equal(s.state, 'soon');
  assert.equal(s.reason, 'data');
  assert.equal(s.stage, '7');
});

test('тревогу поднимает ближайший из двух сроков', () => {
  assert.equal(tokenState({ expiresAt: inDays(4), dataAccessAt: inDays(40) }, NOW).reason, 'token');
  assert.equal(tokenState({ expiresAt: inDays(40), dataAccessAt: inDays(4) }, NOW).reason, 'data');
  // Поровну — токен: его смерть однозначна, про данные у Meta оговорки.
  assert.equal(tokenState({ expiresAt: inDays(4), dataAccessAt: inDays(4) }, NOW).reason, 'token');
});

test('кончившийся доступ к данным — «истёк» с причиной «данные»', () => {
  const s = tokenState({ expiresAt: null, dataAccessAt: inDays(-1) }, NOW);
  assert.equal(s.state, 'expired');
  assert.equal(s.reason, 'data');
});

test('отметка сторожа хранит второй срок и причину', () => {
  saveHealth({ projectId, platform: 'instagram', expiresAt: null, dataAccessAt: inDays(6) }, NOW);
  const row = tokenHealth({ projectId }).find((t) => t.platform === 'instagram');
  assert.equal(row.reason, 'data');
  assert.ok(row.dataAccessAt);
  assert.equal(row.reconnect, 'Подключить через Facebook', 'совет — войти кнопкой, а не перевыпускать токен');
});

function fakeDebug(data) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return calls;
}

test('срок Threads читается у площадки — это факт, а не расчёт', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const expires = Math.floor(Date.now() / 1000) + 30 * 86400;
  const access = Math.floor(Date.now() / 1000) + 50 * 86400;
  const calls = fakeDebug({ is_valid: true, expires_at: expires, data_access_expires_at: access });

  const res = await readExpiry(projectId, 'threads', { accessToken: 'token' });
  assert.ok(calls.some((c) => c.includes('graph.threads.net') && c.includes('debug_token')));
  assert.equal(res.estimated, false);
  assert.equal(new Date(res.expiresAt).getTime(), expires * 1000);
  assert.equal(new Date(res.dataAccessAt).getTime(), access * 1000);
});

test('Threads молчит — остаётся прежний расчёт, помеченный как догадка', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'down' } }) });
  projects.saveAccount(projectId, 'threads', { userId: '1', accessToken: 'fallback'.padEnd(30, 'f') });

  const res = await readExpiry(projectId, 'threads', { accessToken: 'fallback'.padEnd(30, 'f') });
  assert.equal(res.estimated, true);
  assert.ok(res.expiresAt);
});

test('у Facebook доступ к данным не отслеживается, у Instagram — да', async (t) => {
  // Права страниц выведены из-под правила 90 дней — тревога по Facebook
  // была бы ложной. Токен общий, так что предупредит карточка Instagram.
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const soon = Math.floor(Date.now() / 1000) + 3 * 86400;
  fakeDebug({ is_valid: true, expires_at: 0, data_access_expires_at: soon });
  projects.saveAccount(projectId, 'facebook', { pageId: '1', pageToken: 'page'.padEnd(30, 'p'), appId: '1', appSecret: 's' });

  const fb = await readExpiry(projectId, 'facebook', projects.credentialsFor(projectId, 'facebook'));
  const ig = await readExpiry(projectId, 'instagram', { userId: '2', pageToken: 'page'.padEnd(30, 'p') });
  assert.equal(fb.expiresAt, null, 'бессрочный');
  assert.equal(fb.dataAccessAt, null);
  assert.equal(new Date(ig.dataAccessAt).getTime(), soon * 1000);
});
