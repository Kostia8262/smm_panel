/**
 * Telegram — единственная площадка, работающая сразу: ни ревью, ни аудита.
 * Поэтому на ней отлаживается весь конвейер, пока остальные ждут проверок.
 *
 * Медиа шлём файлом (multipart), а не ссылкой: по ссылке Telegram берёт
 * фото только до 5 МБ, а мастер-кадры бывают тяжелее.
 */

import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';

const API = 'https://api.telegram.org';

export const id = 'telegram';

export function isConfigured(creds = {}) {
  return Boolean(creds.botToken && creds.chatId);
}

export function missingConfig(creds = {}) {
  const missing = [];
  if (!creds.botToken) missing.push('токен бота (@BotFather)');
  if (!creds.chatId) missing.push('канал (@имя или числовой id)');
  return missing;
}

async function call(method, form, creds) {
  // Пустую multipart-форму Telegram отвергает голым 400 ещё до проверки токена —
  // так ломался getMe. Без полей шлём запрос без тела.
  const body = [...form.keys()].length ? form : undefined;
  const res = await fetch(`${API}/bot${creds.botToken}/${method}`, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(
      `Telegram ${method}: ${data.description || res.status} ${data.error_code ? `(${data.error_code})` : ''}`
    );
  }
  return data.result;
}

/** Проверка доступа: бот жив и умеет писать в канал. */
export async function check(creds) {
  const me = await call('getMe', new FormData(), creds);
  const form = new FormData();
  form.set('chat_id', creds.chatId);
  const chat = await call('getChat', form, creds);
  return {
    ok: true,
    bot: me.username,
    chat: chat.title || chat.username || String(chat.id),
  };
}

/**
 * @param {{text: string, media: Array<{path: string, kind: string, original_name: string}>}} payload
 */
export async function publish({ text, media = [], creds }) {
  const chatId = creds.chatId;
  const caption = text || '';

  // Без медиа — обычное сообщение.
  if (!media.length) {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('text', caption);
    form.set('parse_mode', 'HTML');
    const msg = await call('sendMessage', form, creds);
    return { externalId: String(msg.message_id), url: messageUrl(chatId, msg.message_id) };
  }

  // Один файл — фото или видео с подписью.
  if (media.length === 1) {
    const m = media[0];
    const isVideo = m.kind === 'video';
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set(isVideo ? 'video' : 'photo', await openAsBlob(m.path), basename(m.path));
    if (caption) {
      // Длинную подпись обрезаем и досылаем остаток — Telegram сам её не примет.
      form.set('caption', caption.slice(0, 1024));
      form.set('parse_mode', 'HTML');
    }
    const msg = await call(isVideo ? 'sendVideo' : 'sendPhoto', form, creds);
    if (caption.length > 1024) await sendTail(chatId, caption.slice(1024), creds);
    return { externalId: String(msg.message_id), url: messageUrl(chatId, msg.message_id) };
  }

  // Несколько файлов — альбом. Подпись разрешена только у первого элемента.
  const form = new FormData();
  form.set('chat_id', chatId);
  const group = media.slice(0, 10).map((m, i) => {
    const item = { type: m.kind === 'video' ? 'video' : 'photo', media: `attach://f${i}` };
    if (i === 0 && caption) {
      item.caption = caption.slice(0, 1024);
      item.parse_mode = 'HTML';
    }
    return item;
  });
  form.set('media', JSON.stringify(group));
  for (const [i, m] of media.slice(0, 10).entries()) {
    form.set(`f${i}`, await openAsBlob(m.path), basename(m.path));
  }
  const msgs = await call('sendMediaGroup', form, creds);
  if (caption.length > 1024) await sendTail(chatId, caption.slice(1024), creds);
  const first = msgs[0];
  return { externalId: String(first.message_id), url: messageUrl(chatId, first.message_id) };
}

async function sendTail(chatId, tail, creds) {
  const form = new FormData();
  form.set('chat_id', chatId);
  form.set('text', tail);
  form.set('parse_mode', 'HTML');
  await call('sendMessage', form, creds);
}

function messageUrl(chatId, messageId) {
  const chat = String(chatId);
  if (chat.startsWith('@')) return `https://t.me/${chat.slice(1)}/${messageId}`;
  return null;
}
