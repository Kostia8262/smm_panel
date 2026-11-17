/**
 * Адрес админки школы и ключи к ней (`PUT /api/settings/leads`).
 *
 * Ключи уходят на `leads_api_url` заголовком. Поэтому (security-audit 17.11, Г3):
 *   - адрес только `https://`; `http://localhost` / `127.0.0.1` — лишь для
 *     стенда, при `ALLOW_HTTP_CRM=1` в окружении;
 *   - смена адреса сбрасывает сохранённые ключи: иначе один неосторожный
 *     адрес уносит туда все три ключа. Новый ключ, присланный тем же
 *     запросом, сохраняется.
 */

import { getSetting, setSetting } from './staff.js';
import { encrypt } from './secrets.js';

export const LEADS_KEYS = ['leads_api_token', 'crm_feed_token', 'crm_leads_write_token'];

export class LeadsSettingsError extends Error {}

/** Пригоден ли адрес, чтобы слать на него ключи. */
export function leadsUrlAllowed(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return u.protocol === 'http:' && local && process.env.ALLOW_HTTP_CRM === '1';
}

/** @returns {{reset: string[]}} какие ключи сброшены сменой адреса */
export function applyLeadsSettings(body = {}) {
  const reset = [];
  if (body.url !== undefined) {
    const next = String(body.url).trim().replace(/\/+$/, '');
    if (!leadsUrlAllowed(next)) {
      throw new LeadsSettingsError('Адрес админки — только https:// (ключи уходят на него заголовком)');
    }
    const current = String(getSetting('leads_api_url', '') || '').replace(/\/+$/, '');
    if (current && next !== current) {
      for (const k of LEADS_KEYS) {
        if (getSetting(k, '')) {
          setSetting(k, '');
          reset.push(k);
        }
      }
    }
    setSetting('leads_api_url', next);
  }
  if (body.token) setSetting('leads_api_token', encrypt(String(body.token).trim()));
  if (body.feedToken) setSetting('crm_feed_token', encrypt(String(body.feedToken).trim()));
  if (body.leadsWriteToken) setSetting('crm_leads_write_token', encrypt(String(body.leadsWriteToken).trim()));
  return { reset: reset.filter((k) => !getSetting(k, '')) };
}
