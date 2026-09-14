/**
 * Подключение TikTok кнопкой: окно согласия TikTok → панель сама получает токены.
 *
 * Порядок по документации Login Kit for Web (сверено 14.09.2026):
 *   1. ссылка на www.tiktok.com/v2/auth/authorize с правами и `state`;
 *   2. TikTok возвращает человека на наш адрес с `code`;
 *   3. code → access token (24 часа) + refresh token (365 дней) и `open_id`.
 *
 * У TikTok токен доступа живёт сутки — сторож раз в шесть часов его не спасёт.
 * Поэтому обновляет его не сторож, а тот, кто идёт к площадке, прямо перед
 * запросом (src/live-creds.js). И главное правило обновления: **refresh token
 * при обновлении может смениться**, и сохранять надо новый — старый TikTok
 * после этого не примет.
 *
 * `state` — тот же зашифрованный, что у Threads (src/oauth/threads.js):
 * проект, сотрудник, площадка и время, подделать нельзя.
 */

const AUTHORIZE = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE = 'https://open.tiktokapis.com/v2/oauth/revoke/';

/**
 * Права. `video.publish` — публикация сразу в ленту, `video.upload` — в
 * черновики (владелец выбрал оба режима 14.09.2026), `user.info.basic` —
 * узнать, чей аккаунт подключили.
 */
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish', 'video.upload'];

export function authorizeUrl({ clientKey, redirectUri, state }) {
  const params = new URLSearchParams({
    client_key: String(clientKey),
    scope: TIKTOK_SCOPES.join(','),
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTHORIZE}?${params}`;
}

async function tokenCall(body, step, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams(body),
    });
  } catch (err) {
    throw new Error(`TikTok, ${step}: площадка не отвечает (${err.message})`);
  }
  const data = await res.json().catch(() => ({}));
  // Отказ приходит то полями верхнего уровня, то объектом error — понимаем оба.
  const error = data.error && typeof data.error === 'object' ? data.error.code : data.error;
  if (!res.ok || (error && error !== 'ok') || !data.access_token) {
    const description = data.error_description || data.error?.message || error || `ошибка ${res.status}`;
    throw new Error(`TikTok, ${step}: ${description}`);
  }
  return data;
}

/** Ответ площадки → поля карточки проекта. Сроки — датами, а не секундами. */
export function tokenValues(data, now = Date.now()) {
  const at = (seconds) => (Number(seconds) > 0 ? new Date(now + Number(seconds) * 1000).toISOString() : '');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    openId: data.open_id || '',
    accessExpiresAt: at(data.expires_in),
    refreshExpiresAt: at(data.refresh_expires_in),
    scopes: String(data.scope || ''),
  };
}

/**
 * Обменять код на токены.
 * @returns {{values: object, scopes: string[], missing: string[]}}
 */
export async function exchangeCode({ clientKey, clientSecret, redirectUri, code }, { fetchImpl = fetch, now = Date.now() } = {}) {
  const data = await tokenCall(
    {
      client_key: clientKey,
      client_secret: clientSecret,
      code: String(code || ''),
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    },
    'обмен кода',
    fetchImpl
  );
  const values = tokenValues(data, now);
  const scopes = values.scopes.split(',').map((s) => s.trim()).filter(Boolean);
  return { values, scopes, missing: scopes.length ? TIKTOK_SCOPES.filter((s) => !scopes.includes(s)) : [] };
}

/** Обновить токен доступа. Refresh token в ответе может быть новым — возвращаем как есть. */
export async function refreshTokens({ clientKey, clientSecret, refreshToken }, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!refreshToken) throw new Error('TikTok: нет refresh token — подключите TikTok кнопкой заново');
  const data = await tokenCall(
    {
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    'обновление токена',
    fetchImpl
  );
  const values = tokenValues(data, now);
  // Не прислали новый refresh — действует прежний: терять его нельзя.
  if (!values.refreshToken) values.refreshToken = refreshToken;
  return values;
}

/** Отозвать доступ панели у аккаунта TikTok — при «Снять доступ». */
export async function revoke({ clientKey, clientSecret, accessToken }, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(REVOKE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, token: accessToken }),
  });
  return res.ok;
}
