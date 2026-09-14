/**
 * Доступы площадки, готовые к запросу прямо сейчас.
 *
 * Для всех площадок, кроме TikTok, это просто `credentialsFor`. У TikTok
 * токен доступа живёт сутки (сверено 14.09.2026), и обновлять его раз в шесть
 * часов сторожем — значит однажды опубликовать пост протухшим токеном. Поэтому
 * каждый, кто идёт к TikTok (очередь, «Проверить связь», композер, сторож),
 * берёт доступы отсюда: за полчаса до смерти токен обновляется и сохраняется.
 *
 * Гонка двух процессов (веб-морда и воркер обновляют одновременно) возможна:
 * TikTok при обновлении может выдать новый refresh token, и второй запрос со
 * старым получит отказ. Тогда перечитываем карточку — скорее всего, соседний
 * процесс уже сохранил свежий токен, — и только если нет, признаёмся в поломке.
 */

import { credentialsFor, saveAccount } from './projects.js';
import { refreshTokens } from './oauth/tiktok.js';
import { log } from './db.js';

/** За сколько до смерти токена доступа обновлять. */
export const TIKTOK_REFRESH_MARGIN_MS = 30 * 60 * 1000;

function fresh(creds, now) {
  const until = Date.parse(creds.accessExpiresAt || '');
  return Boolean(creds.accessToken) && Number.isFinite(until) && until - now > TIKTOK_REFRESH_MARGIN_MS;
}

/**
 * @param {number} projectId
 * @param {string} platform
 * @param {{now?: number, refresh?: Function}} [opts] — подмены для тестов
 */
export async function liveCredentials(projectId, platform, { now = Date.now(), refresh = refreshTokens } = {}) {
  const creds = credentialsFor(projectId, platform);
  if (platform !== 'tiktok' || !creds.refreshToken || !creds.clientKey || !creds.clientSecret) return creds;
  if (fresh(creds, now)) return creds;

  try {
    const values = await refresh(creds);
    saveAccount(projectId, 'tiktok', values, { quiet: true });
    return { ...creds, ...values };
  } catch (err) {
    const again = credentialsFor(projectId, platform);
    if (again.accessToken !== creds.accessToken && fresh(again, now)) return again;
    log('error', `токен TikTok не обновился: ${err.message}`, { platform: 'tiktok' });
    throw new Error(`${err.message}. Подключите TikTok кнопкой заново`);
  }
}
