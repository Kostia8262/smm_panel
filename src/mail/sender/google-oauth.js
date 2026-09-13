/**
 * Подключение ящика Google кнопкой: окно согласия → код → refresh-токен.
 *
 * Права — ровно `gmail.send` плюс адрес ящика (`openid email`): панель
 * отправляет письма и не может читать почту. Google показывает права
 * галочками, и `gmail.send` можно снять — такой ответ не сохраняем, а говорим
 * прямо, что галочку сняли.
 *
 * `prompt=consent` обязателен: без него при повторном подключении Google не
 * вернёт refresh-токен, и ящик «подключится» без возможности отправлять.
 */

import { GOOGLE_SCOPES, GMAIL_SEND_SCOPE } from '../specs.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export class GoogleAuthError extends Error {
  /** @param {'dead'|'config'|'denied'|'temporary'} kind */
  constructor(message, kind = 'temporary') {
    super(message);
    this.kind = kind;
  }
}

export function authorizeUrl({ clientId, redirectUri, state, loginHint = '' }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_URL}?${params}`;
}

/** Разбор ответа Google в понятную ошибку: что именно не так и можно ли повторить. */
function explain(data, status) {
  const code = data?.error || '';
  const description = data?.error_description || '';
  if (code === 'invalid_grant') {
    return new GoogleAuthError(
      'Google отозвал доступ: сменили пароль, отключили приложение в аккаунте, полгода не пользовались или приложение в режиме Testing (7 дней). Подключите ящик заново',
      'dead'
    );
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return new GoogleAuthError('Google не узнал приложение: проверьте ID и секрет клиента в панели', 'config');
  }
  if (code === 'redirect_uri_mismatch') {
    return new GoogleAuthError('Адрес возврата не совпадает с вписанным в Google Cloud (Clients → Authorized redirect URIs)', 'config');
  }
  if (status >= 500) return new GoogleAuthError(`Google временно не отвечает (${status})`, 'temporary');
  return new GoogleAuthError(`Google отказал: ${description || code || status}`, 'temporary');
}

async function postForm(url, form, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
  } catch (err) {
    throw new GoogleAuthError(`Google не отвечает: ${err.message}`, 'temporary');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw explain(data, res.status);
  return data;
}

/**
 * Адрес ящика из id_token. Подпись не проверяем: токен пришёл напрямую от
 * Google по TLS в ответ на наш запрос с секретом клиента, подменить его в пути
 * нельзя.
 */
export function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return payload.email_verified === false ? '' : String(payload.email || '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * @returns {Promise<{refreshToken: string, accessToken: string, accessExpiresAt: number, email: string,
 *   scopes: string[], refreshExpiresAt: string|null}>}
 */
export async function exchangeCode({ clientId, clientSecret, redirectUri, code, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const data = await postForm(
    TOKEN_URL,
    { code: String(code || ''), client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' },
    fetchImpl
  );

  const scopes = String(data.scope || '').split(/\s+/).filter(Boolean);
  if (!scopes.includes(GMAIL_SEND_SCOPE)) {
    throw new GoogleAuthError('В окне Google не отмечено право «Отправлять письма от вашего имени». Подключите заново и оставьте эту галочку', 'denied');
  }
  if (!data.refresh_token) {
    throw new GoogleAuthError('Google не выдал долгий доступ. Отзовите доступ приложения в настройках аккаунта Google и подключите заново', 'denied');
  }
  const email = emailFromIdToken(data.id_token);
  if (!email) throw new GoogleAuthError('Google не сообщил адрес ящика — проверьте, что отмечено право видеть адрес почты', 'denied');

  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    accessExpiresAt: now + (Number(data.expires_in) || 3600) * 1000,
    email,
    scopes,
    // Google называет срок, только когда доступ временный: так выглядит
    // приложение, забытое в режиме Testing. Бессрочный токен срока не имеет.
    refreshExpiresAt: data.refresh_token_expires_in ? new Date(now + Number(data.refresh_token_expires_in) * 1000).toISOString() : null,
  };
}

/** @returns {Promise<{accessToken: string, accessExpiresAt: number}>} */
export async function refreshAccess({ clientId, clientSecret, refreshToken, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const data = await postForm(
    TOKEN_URL,
    { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' },
    fetchImpl
  );
  return { accessToken: data.access_token, accessExpiresAt: now + (Number(data.expires_in) || 3600) * 1000 };
}

/** Отозвать доступ у Google. Ошибка не мешает отключению в панели — токен всё равно удаляется. */
export async function revoke(token, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
