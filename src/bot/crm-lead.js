/**
 * Заявка в CRM школы, когда бот собрал имя и телефон (docs/бот.md, §5b).
 *
 * Куда: админка `mycomputer.education` (база main.db, таблица leads). Дату
 * заявки (`ДД.ММ.ГГГГ`) ставит сама админка в `insertLead()` — панель её не
 * передаёт.
 *
 * Два пути, выбор — по виду ключа в «Настройках → Связь с заявками школы»:
 *
 *   1. Сейчас: `POST /api/leads/admin` с заголовком `x-admin-token` — тот же
 *      путь, которым лендинги сети пересылают свои заявки. Нужен токен
 *      сотрудника админки (роль «менеджер»), не суперадмина.
 *   2. Предложено (в админке ещё нет): `POST /api/integration/leads` с
 *      `x-integration-key` (ключ `mcai_…`) и правом `leads:write`. Узкий ключ
 *      вместо токена сотрудника; см. docs/бот.md, «Что нужно в админке».
 *
 * Без ключа заявка не создаётся, а диалог помечается «заявка не создана» —
 * человек всё равно получает его во «Входящих» с телефоном.
 */

import { getSetting } from '../staff.js';
import { decrypt } from '../secrets.js';

export const LEAD_SOURCE = 'ig_dm';
/** Messenger — своя метка: заявки из Facebook не смешиваются с Instagram. */
export const LEAD_SOURCE_FB = 'fb_dm';

let fetchImpl = (...a) => fetch(...a);
export function setFetch(fn) {
  fetchImpl = fn || ((...a) => fetch(...a));
}

export function leadAccess() {
  const stored = getSetting('crm_leads_write_token', '');
  let key = '';
  if (stored) {
    try {
      key = decrypt(stored);
    } catch {
      key = '';
    }
  }
  return { apiUrl: String(getSetting('leads_api_url', 'https://mycomputer.education') || '').replace(/\/+$/, ''), key };
}

/** Тело заявки: поля те же, что принимает `/api/leads/admin`. */
export function leadBody(dialog) {
  const notes = [
    `Заявка з ${dialog.channel === 'messenger' ? 'Messenger' : 'Instagram Direct'} — зібрав бот`,
    dialog.preferred_time ? `Зручно: ${dialog.preferred_time}` : '',
    dialog.tags ? `Мітки: ${dialog.tags}` : '',
    dialog.lang === 'ru' ? 'Пише російською' : '',
  ].filter(Boolean).join('\n');
  // Админка требует имя от двух букв: без имени — понятная заглушка.
  const name = dialog.contact_name && dialog.contact_name.length >= 2 ? dialog.contact_name : 'Без імені (Direct)';
  return {
    child_name: name,
    age: dialog.child_age || null,
    phone: dialog.phone,
    // /api/leads/admin берёт source как есть (sanitize, без списка) — fb_dm проходит.
    source: dialog.channel === 'messenger' ? LEAD_SOURCE_FB : LEAD_SOURCE,
    notes,
    utm_source: dialog.channel === 'messenger' ? 'facebook' : 'instagram',
    utm_medium: dialog.channel === 'messenger' ? 'messenger' : 'direct',
  };
}

/**
 * @returns {Promise<{status: 'sent'|'failed'|'no_access', id?: string, error?: string}>}
 */
export async function createLead(dialog) {
  const { apiUrl, key } = leadAccess();
  if (!key || !apiUrl) return { status: 'no_access', error: 'нет ключа для записи заявок в админку' };
  const integration = key.startsWith('mcai_');
  const url = `${apiUrl}${integration ? '/api/integration/leads' : '/api/leads/admin'}`;
  const headers = { 'content-type': 'application/json', [integration ? 'x-integration-key' : 'x-admin-token']: key };
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(leadBody(dialog)), signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'failed', error: `админка ответила ${res.status}${data.error ? `: ${String(data.error).slice(0, 120)}` : ''}` };
    const id = data.lead?.id ?? data.id ?? null;
    return { status: 'sent', id: id === null ? null : String(id) };
  } catch (err) {
    return { status: 'failed', error: `админка не ответила: ${err.message}` };
  }
}
