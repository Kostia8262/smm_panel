/**
 * Отправка сообщения в Direct Instagram и Messenger через Send API Graph.
 *
 * Доступ — существующий слой токенов: токен страницы из карточки площадки
 * проекта (`credentialsFor`), тот же, которым панель публикует. Для Instagram,
 * подключённого «входом через Facebook», сообщение идёт через страницу:
 * `POST /me/messages` с токеном страницы и IGSID получателя.
 *
 * В тестах и локальных прогонах настоящих вызовов Meta нет: `BOT_SEND_MODE=stub`
 * (или NODE_ENV=test) подменяет отправку заглушкой, которая выдаёт
 * выдуманный mid и пишет его в журнал заглушки. Заглушку можно и подменить
 * целиком через `setSender()` — так делают тесты.
 */

import { randomBytes } from 'node:crypto';
import { GRAPH_API } from '../platforms/graph.js';
import { credentialsFor } from '../projects.js';

export class SendError extends Error {
  constructor(message, { code = null, windowClosed = false } = {}) {
    super(message);
    this.code = code;
    this.windowClosed = windowClosed;
  }
}

/** Что отправила заглушка — для живого прогона и проверок. */
export const stubOutbox = [];

let custom = null;
export function setSender(fn) {
  custom = fn;
}

export function stubMode() {
  return process.env.BOT_SEND_MODE === 'stub' || process.env.NODE_ENV === 'test';
}

function tokenFor(projectId, channel) {
  const creds = credentialsFor(projectId, channel === 'messenger' ? 'facebook' : 'instagram');
  if (creds.pageToken) return creds.pageToken;
  // Instagram сидит на токене страницы: если в карточке Instagram его нет,
  // берём токен Facebook того же проекта.
  return credentialsFor(projectId, 'facebook').pageToken || null;
}

/**
 * @returns {Promise<{mid: string}>}
 */
export async function sendText({ projectId, channel, peerId, text }) {
  if (custom) return custom({ projectId, channel, peerId, text });
  if (stubMode()) {
    const mid = `stub.${randomBytes(9).toString('base64url')}`;
    stubOutbox.push({ projectId, channel, peerId, text, mid, at: new Date().toISOString() });
    return { mid };
  }
  const token = tokenFor(projectId, channel);
  if (!token) throw new SendError('нет токена страницы в карточке площадки');
  const body = {
    recipient: { id: peerId },
    message: { text },
    // В окне 24 часов ответ на сообщение клиента — RESPONSE; метки за окном
    // бот не ставит: вне окна он не пишет вовсе (docs/бот.md, §2).
    messaging_type: 'RESPONSE',
  };
  const res = await fetch(`${GRAPH_API}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = data.error || {};
    // 10 / 2018278 — «сообщение вне разрешённого окна».
    const windowClosed = err.code === 10 || err.error_subcode === 2018278 || err.error_subcode === 2534022;
    throw new SendError(`Send API: ${err.message || res.status}`, { code: err.code ?? res.status, windowClosed });
  }
  if (!data.message_id) throw new SendError('Send API не вернул id сообщения');
  return { mid: data.message_id };
}
