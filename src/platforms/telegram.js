/**
 * Telegram — единственная площадка, работающая сразу: ни ревью, ни аудита.
 * Поэтому на ней отлаживается весь конвейер, пока остальные ждут проверок.
 *
 * Медиа шлём файлом (multipart), а не ссылкой: по ссылке Telegram берёт
 * фото только до 5 МБ, а мастер-кадры бывают тяжелее.
 *
 * Текст уходит как есть, без `parse_mode`. До 13.09.2026 шёл с HTML-разметкой,
 * которую композер не пишет: «Q&A» или «ціна <500 грн» Telegram отклонял
 * ошибкой разбора, и пост не выходил вовсе.
 *
 * Пост может занять несколько сообщений: подпись к медиа — до 1024 символов,
 * сообщение — до 4096, остальное досылается следом. В `externalId` лежат id
 * всех сообщений через запятую: удалять надо все, а ссылка ведёт на первое.
 */

import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';

const API = 'https://api.telegram.org';

export const TEXT_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;

/** Служебные вызовы короткие; выгрузку видео ограничивает сам Node (5 минут без ответа). */
const CALL_TIMEOUT_MS = 30_000;
/** Сколько раз переждать «слишком часто» (429). Такой отказ значит «не отправлено» — повтор безопасен. */
const FLOOD_RETRIES = 2;
const FLOOD_MAX_WAIT_S = 60;

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

/**
 * Канал в том виде, который понимает Bot API: `@имя` или числовой id.
 *
 * В карточку вписывают и ссылку `https://t.me/имя` — 13.09.2026 так и было, и
 * Telegram отвечал «chat not found». Ссылку-приглашение (`t.me/+…`) превратить
 * в канал нельзя: у приватного канала есть только числовой id.
 */
export function normalizeChatId(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^-?\d+$/.test(value)) return value;

  const link = value.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(.+)$/i);
  let name = link ? link[1].replace(/^s\//, '') : value;
  if (name.startsWith('+') || /^joinchat\b/i.test(name)) {
    throw new Error('Вписана ссылка-приглашение — у приватного канала нужен числовой id вида -100…');
  }
  name = name.replace(/^@/, '').split(/[/?#]/)[0];
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)) {
    throw new Error(`Не похоже на канал: «${value}». Нужно @имя_канала или числовой id`);
  }
  return `@${name}`;
}

/**
 * Разрезать текст на части не длиннее лимита.
 *
 * Режем по абзацу, строке, концу предложения или пробелу — не посреди слова и
 * не посреди ссылки: разрезанная короткая ссылка в канале просто не открывается.
 * Раньше резали ровно по 1024-му символу. Искать место разреза не дальше
 * середины части: иначе одно длинное предложение даст крошечный первый кусок.
 */
export function splitText(text, firstLimit, restLimit = TEXT_LIMIT) {
  const parts = [];
  let rest = String(text ?? '');
  let limit = firstLimit;
  while (rest.length > limit) {
    const cut = cutPoint(rest, limit);
    const head = rest.slice(0, cut).trimEnd();
    if (head) parts.push(head);
    rest = rest.slice(cut).trimStart();
    limit = restLimit;
  }
  if (rest) parts.push(rest);
  return parts;
}

function cutPoint(text, limit) {
  // Символ сразу за пределом тоже смотрим: пробел там — законное место разреза.
  const window = text.slice(0, limit + 1);
  const floor = Math.floor(limit / 2);
  const rules = [
    { re: /\n[ \t]*\n/g, after: false },
    { re: /\n/g, after: false },
    { re: /[.!?…](?=\s)/g, after: true },
    { re: /\s/g, after: false },
  ];
  for (const { re, after } of rules) {
    let best = -1;
    for (const m of window.matchAll(re)) {
      const at = after ? m.index + m[0].length : m.index;
      if (at >= floor && at <= limit) best = at;
    }
    if (best > 0) return best;
  }
  // Сплошной текст без пробелов — режем по лимиту, но не пополам эмодзи.
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, form, creds, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  // Пустую multipart-форму Telegram отвергает голым 400 ещё до проверки токена —
  // так ломался getMe. Без полей шлём запрос без тела.
  const body = [...form.keys()].length ? form : undefined;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API}/bot${creds.botToken}/${method}`, {
        method: 'POST',
        body,
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (err) {
      const why = err.name === 'TimeoutError' ? `не ответил за ${Math.round(timeoutMs / 1000)} с` : err.message;
      throw new Error(`Telegram ${method}: ${why}`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) return data.result;

    const wait = Number(data.parameters?.retry_after);
    if (data.error_code === 429 && wait > 0 && wait <= FLOOD_MAX_WAIT_S && attempt < FLOOD_RETRIES) {
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(
      `Telegram ${method}: ${data.description || res.status}${data.error_code ? ` (${data.error_code})` : ''}`
    );
  }
}

/**
 * Что бот может в чате. Чистая функция — ответы Telegram разбираются тестом.
 *
 * В канале публикует только администратор с правом публикации. Раньше проверка
 * связи смотрела лишь getChat, а публичный канал отвечает на него и чужому
 * боту — «связь есть» горело там, где пост не ушёл бы.
 */
export function botRights(chat, member) {
  const status = member?.status;
  if (status === 'creator') return { canPost: true, canDelete: true, problem: null };

  if (chat?.type === 'channel') {
    if (status !== 'administrator') {
      return { canPost: false, canDelete: false, problem: 'бот не администратор канала — добавьте его в «Администраторы»' };
    }
    const canPost = member.can_post_messages !== false;
    return {
      canPost,
      canDelete: Boolean(member.can_delete_messages),
      problem: canPost ? null : 'у бота нет права «Публикация сообщений»',
    };
  }

  // Группа: писать может и обычный участник, если его не ограничили.
  if (status === 'left' || status === 'kicked') {
    return { canPost: false, canDelete: false, problem: 'бота нет в группе' };
  }
  const canPost = status !== 'restricted' || member.can_send_messages !== false;
  return {
    canPost,
    canDelete: status === 'administrator' ? Boolean(member.can_delete_messages) : true,
    problem: canPost ? null : 'боту запрещено писать в группе',
  };
}

/** Проверка доступа: бот жив, видит канал и имеет право в нём публиковать. */
export async function check(creds) {
  const chatId = normalizeChatId(creds.chatId);
  const me = await call('getMe', new FormData(), creds);

  const chatForm = new FormData();
  chatForm.set('chat_id', chatId);
  const chat = await call('getChat', chatForm, creds);

  const memberForm = new FormData();
  memberForm.set('chat_id', chatId);
  memberForm.set('user_id', String(me.id));
  let member;
  try {
    member = await call('getChatMember', memberForm, creds);
  } catch (err) {
    throw new Error(`бот не видит канал изнутри — добавьте его администратором (${err.message})`);
  }

  const rights = botRights(chat, member);
  if (!rights.canPost) throw new Error(`Telegram: ${rights.problem}`);

  const result = {
    ok: true,
    bot: me.username,
    chat: chat.title || chat.username || String(chat.id),
    canDelete: rights.canDelete,
  };
  if (!rights.canDelete) {
    result.warning = `публиковать может, а снять пост — нет: дайте боту право «Удаление сообщений» в «${result.chat}»`;
  }
  return result;
}

/**
 * @param {{text: string, media: Array<{path: string, kind: string, width?: number, height?: number, duration?: number}>}} payload
 * @returns {Promise<{externalId: string, url: string|null, warning?: string}>}
 */
export async function publish({ text, media = [], creds }) {
  const chatId = normalizeChatId(creds.chatId);
  const body = String(text || '').trim();

  let ids;
  let tails;

  if (!media.length) {
    // Без медиа — обычное сообщение. Длиннее 4096 текст становится после
    // подмены ссылок короткими: проверка поста считает его до подмены.
    const [first = '', ...rest] = splitText(body, TEXT_LIMIT);
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('text', first);
    const msg = await call('sendMessage', form, creds);
    ids = [msg.message_id];
    tails = rest;
  } else if (media.length === 1) {
    const [caption, ...rest] = splitText(body, CAPTION_LIMIT);
    const m = media[0];
    const isVideo = m.kind === 'video';
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set(isVideo ? 'video' : 'photo', await openAsBlob(m.path), basename(m.path));
    if (caption) form.set('caption', caption);
    if (isVideo) for (const [k, v] of Object.entries(videoFields(m))) form.set(k, String(v));
    // Выгрузку не режем своим таймаутом: 50 МБ по медленному каналу идут долго.
    const msg = await call(isVideo ? 'sendVideo' : 'sendPhoto', form, creds, { timeoutMs: 0 });
    ids = [msg.message_id];
    tails = rest;
  } else {
    // Несколько файлов — альбом. Подпись разрешена только у первого элемента.
    const [caption, ...rest] = splitText(body, CAPTION_LIMIT);
    const files = media.slice(0, 10);
    const form = new FormData();
    form.set('chat_id', chatId);
    const group = files.map((m, i) => {
      const item = { type: m.kind === 'video' ? 'video' : 'photo', media: `attach://f${i}` };
      if (m.kind === 'video') Object.assign(item, videoFields(m));
      if (i === 0 && caption) item.caption = caption;
      return item;
    });
    form.set('media', JSON.stringify(group));
    for (const [i, m] of files.entries()) {
      form.set(`f${i}`, await openAsBlob(m.path), basename(m.path));
    }
    const msgs = await call('sendMediaGroup', form, creds, { timeoutMs: 0 });
    ids = msgs.map((x) => x.message_id);
    tails = rest;
  }

  // Главное сообщение уже в канале. Упавшее продолжение нельзя превращать в
  // ошибку поста: повтор выпустил бы фото второй раз — дублем.
  const out = { externalId: '', url: messageUrl(chatId, ids[0]) };
  for (const [i, tail] of tails.entries()) {
    try {
      const form = new FormData();
      form.set('chat_id', chatId);
      form.set('text', tail);
      const msg = await call('sendMessage', form, creds);
      ids.push(msg.message_id);
    } catch (err) {
      out.warning = `пост вышел, но продолжение текста (${tails.length - i} из ${tails.length} сообщ.) не отправлено — ${err.message}. Дошлите его в канал руками`;
      break;
    }
  }
  out.externalId = ids.join(',');
  return out;
}

/**
 * Размеры и длительность ролика. Без них Telegram показывает вертикальное видео
 * квадратом, а без `supports_streaming` смотреть можно только после загрузки.
 */
function videoFields(m) {
  const fields = { supports_streaming: true };
  if (m.width && m.height) Object.assign(fields, { width: Math.round(m.width), height: Math.round(m.height) });
  if (m.duration) fields.duration = Math.round(m.duration);
  return fields;
}

/**
 * Снять пост — все его сообщения. Бот должен иметь право удалять сообщения.
 * По одному, а не deleteMessages: тот молча пропускает то, что удалить не
 * смог, и «удалено» при висящем в канале посте хуже честной ошибки.
 */
export async function remove(externalId, creds) {
  const chatId = normalizeChatId(creds.chatId);
  const ids = String(externalId ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error('Telegram: нечего удалять — нет id сообщения');
  for (const messageId of ids) {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('message_id', messageId);
    try {
      await call('deleteMessage', form, creds);
    } catch (err) {
      // Уже снятое при прошлой, оборвавшейся попытке — не повод застрять.
      if (!/message to delete not found/i.test(err.message)) throw err;
    }
  }
}

/**
 * Ссылка на сообщение. У приватного канала вида `-100…` она открывается
 * только участникам, но всё равно ведёт на пост.
 */
export function messageUrl(chatId, messageId) {
  const chat = String(chatId);
  if (chat.startsWith('@')) return `https://t.me/${chat.slice(1)}/${messageId}`;
  if (chat.startsWith('-100')) return `https://t.me/c/${chat.slice(4)}/${messageId}`;
  return null;
}
