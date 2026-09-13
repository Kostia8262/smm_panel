/**
 * Подключение Threads кнопкой: окно согласия Threads → панель сама получает токен.
 *
 * Зачем, если есть «Генератор маркеров» в кабинете Meta: 13.09.2026 выяснилось,
 * что генератор выдаёт фиксированный набор прав и не берёт добавленные в
 * сценарий `threads_delete` и `threads_keyword_search`. Три токена подряд
 * публиковали, но не умели удалять, а поиск трендов видел только свои посты.
 * Здесь список прав задаём мы, явно, в самой ссылке на согласие.
 *
 * Попутно исчезают две ручные операции, на которых уже ошибались: копирование
 * токена из кабинета и поле «ID аккаунта», куда дважды попадал ID приложения.
 *
 * Порядок по документации Threads:
 *   1. ссылка на threads.net/oauth/authorize с правами и `state`;
 *   2. Threads возвращает человека на наш адрес с `code`;
 *   3. code → короткий токен (час) → долгий (60 дней);
 *   4. `me` даёт настоящий ID, `debug_token` — фактически выданные права.
 */

import { encrypt, decrypt } from '../secrets.js';

const API = 'https://graph.threads.net';

/**
 * Права, которые просим. Всё, что добавлено в сценарий приложения: владелец
 * выбрал так 13.09.2026, чтобы не перевыпускать токен ради каждого нового права.
 */
export const THREADS_SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_delete',
  'threads_keyword_search',
  'threads_manage_insights',
  'threads_read_replies',
  'threads_manage_replies',
];

/** Без этих прав панель не выполняет свою работу — о нехватке говорим вслух. */
export const REQUIRED_SCOPES = ['threads_basic', 'threads_content_publish', 'threads_delete'];

/** Сколько живёт ссылка на согласие: Threads отдаёт код за минуты, дольше незачем. */
const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * `state` — защита от подмены аккаунта.
 *
 * Без неё чужой человек мог бы подсунуть владельцу ссылку возврата со своим
 * кодом, и панель привязала бы к школе ЧУЖОЙ Threads: посты академии уходили
 * бы в посторонний аккаунт. Поэтому в `state` зашиты проект, сотрудник, начавший
 * подключение, и время, а сам он зашифрован ключом панели с проверкой
 * целостности (AES-GCM) — подделать или переписать его нельзя. Хранить его на
 * сервере не нужно, и перезапуск панели посреди подключения его не ломает.
 */
export function makeState({ projectId, staffId }, now = Date.now()) {
  return encrypt(JSON.stringify({ p: projectId, s: staffId, t: now }));
}

/** @returns {{projectId: number}} или бросает с объяснением */
export function readState(state, { staffId }, now = Date.now()) {
  let data;
  try {
    data = JSON.parse(decrypt(state));
  } catch {
    throw new Error('ссылка возврата повреждена или подделана — начните подключение заново');
  }
  if (!data?.p || !data?.t) throw new Error('ссылка возврата неполная — начните подключение заново');
  if (now - data.t > STATE_TTL_MS) throw new Error('ссылка устарела — начните подключение заново');
  if (String(data.s) !== String(staffId)) {
    throw new Error('подключение начато другим сотрудником — начните его под своим входом');
  }
  return { projectId: Number(data.p) };
}

/** Ссылка на окно согласия Threads. */
export function authorizeUrl({ appId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: String(appId),
    redirect_uri: redirectUri,
    scope: THREADS_SCOPES.join(','),
    response_type: 'code',
    state,
  });
  return `https://threads.net/oauth/authorize?${params}`;
}

async function readJson(res, step) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const message = data.error?.message || data.error_message || data.error || res.status;
    throw new Error(`Threads, ${step}: ${message}`);
  }
  return data;
}

/**
 * Обменять код на долгий токен и узнать, чей он и что умеет.
 *
 * @returns {{accessToken: string, expiresIn: number|null, userId: string, username: string, scopes: string[], missing: string[]}}
 */
export async function exchangeCode({ appId, appSecret, redirectUri, code }) {
  // Код иногда копируют вместе с хвостом «#_», который Threads дописывает к
  // адресу возврата. На сервер фрагмент не приходит, но через буфер обмена
  // приходит — срезаем, иначе обмен отбивается невнятным «invalid code».
  const cleanCode = String(code || '').replace(/#_?$/, '');

  const short = await readJson(
    await fetch(`${API}/oauth/access_token`, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: String(appId),
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: cleanCode,
      }),
    }),
    'обмен кода'
  );

  const long = await readJson(
    await fetch(
      `${API}/access_token?${new URLSearchParams({
        grant_type: 'th_exchange_token',
        client_secret: appSecret,
        access_token: short.access_token,
      })}`
    ),
    'долгий токен'
  );
  const accessToken = long.access_token;

  // ID — у площадки: ради этого поле «ID аккаунта» больше не заполняется руками.
  const me = await readJson(
    await fetch(`${API}/v1.0/me?fields=id,username&access_token=${accessToken}`),
    'чей токен'
  );

  // Фактически выданные права. Человек может снять галочку в окне согласия, и
  // узнать об этом надо сейчас, а не при первой неудачной попытке удалить пост.
  let scopes = [];
  try {
    const debug = await readJson(
      await fetch(`${API}/v1.0/debug_token?input_token=${accessToken}&access_token=${accessToken}`),
      'права токена'
    );
    scopes = debug.data?.scopes || [];
  } catch {
    scopes = [];
  }

  return {
    accessToken,
    expiresIn: Number(long.expires_in) || null,
    userId: String(me.id),
    username: me.username || '',
    scopes,
    missing: scopes.length ? REQUIRED_SCOPES.filter((s) => !scopes.includes(s)) : [],
  };
}
