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
// Деление текста на сообщения — общее с превью композера.
import { splitText, TEXT_LIMIT, CAPTION_LIMIT } from '../text-split.js';
export { splitText, TEXT_LIMIT, CAPTION_LIMIT };

const API = 'https://api.telegram.org';

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
  if (status === 'creator') return { canPost: true, canDelete: true, canPin: true, problem: null };

  if (chat?.type === 'channel') {
    if (status !== 'administrator') {
      return { canPost: false, canDelete: false, canPin: false, problem: 'бот не администратор канала — добавьте его в «Администраторы»' };
    }
    const canPost = member.can_post_messages !== false;
    return {
      canPost,
      canDelete: Boolean(member.can_delete_messages),
      // Закреп в канале Telegram привязал к праву править чужие публикации.
      canPin: Boolean(member.can_edit_messages),
      problem: canPost ? null : 'у бота нет права «Публикация сообщений»',
    };
  }

  // Группа: писать может и обычный участник, если его не ограничили.
  if (status === 'left' || status === 'kicked') {
    return { canPost: false, canDelete: false, canPin: false, problem: 'бота нет в группе' };
  }
  const canPost = status !== 'restricted' || member.can_send_messages !== false;
  const admin = status === 'administrator';
  return {
    canPost,
    canDelete: admin ? Boolean(member.can_delete_messages) : true,
    canPin: admin ? Boolean(member.can_pin_messages) : false,
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
    canPin: rights.canPin,
  };
  const missing = [];
  if (!rights.canDelete) missing.push('снимать посты — право «Удаление сообщений»');
  if (!rights.canPin) missing.push(`закреплять — право «${chat.type === 'channel' ? 'Изменение публикаций' : 'Закрепление сообщений'}»`);
  if (missing.length) {
    result.warning = `публиковать может, но не может ${missing.join(' и ')} в «${result.chat}»`;
  }
  return result;
}

/** Кнопка-ссылка под сообщением; пустая клавиатура снимает прежнюю. */
function keyboard(button) {
  const rows = button?.text && button?.url ? [[{ text: button.text, url: button.url }]] : [];
  return JSON.stringify({ inline_keyboard: rows });
}

const NO_PREVIEW = JSON.stringify({ is_disabled: true });

/**
 * @param {{text: string, media: Array<{path: string, kind: string, width?: number, height?: number, duration?: number}>,
 *   options?: {pin?: boolean, noPreview?: boolean, button?: {text: string, url: string}}}} payload
 * @returns {Promise<{externalId: string, url: string|null, warning?: string}>}
 */
export async function publish({ text, media = [], creds, options = {} }) {
  const chatId = normalizeChatId(creds.chatId);
  const body = String(text || '').trim();
  const button = options.button?.text && options.button?.url ? options.button : null;
  const warnings = [];

  let ids;
  let tails;

  // Кнопка — под последним сообщением поста: там кончается текст и стоит
  // призыв. Сразу у главного — только если продолжения нет.
  const buttonOnMain = (rest) => button && !rest.length;

  if (!media.length) {
    // Без медиа — обычное сообщение. Длиннее 4096 текст становится после
    // подмены ссылок короткими: проверка поста считает его до подмены.
    const [first = '', ...rest] = splitText(body, TEXT_LIMIT);
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('text', first);
    if (options.noPreview) form.set('link_preview_options', NO_PREVIEW);
    if (buttonOnMain(rest)) form.set('reply_markup', keyboard(button));
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
    if (buttonOnMain(rest)) form.set('reply_markup', keyboard(button));
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
    // Альбому Telegram клавиатуру не даёт; проверка поста такое не пускает,
    // но если дошло — говорим, а не теряем кнопку молча.
    if (button && !rest.length) warnings.push('к альбому кнопку Telegram не прикрепляет — пост вышел без неё');
  }

  // Главное сообщение уже в канале. Упавшее продолжение нельзя превращать в
  // ошибку поста: повтор выпустил бы фото второй раз — дублем.
  const out = { externalId: '', url: messageUrl(chatId, ids[0]) };
  for (const [i, tail] of tails.entries()) {
    try {
      const form = new FormData();
      form.set('chat_id', chatId);
      form.set('text', tail);
      if (options.noPreview) form.set('link_preview_options', NO_PREVIEW);
      if (button && i === tails.length - 1) form.set('reply_markup', keyboard(button));
      const msg = await call('sendMessage', form, creds);
      ids.push(msg.message_id);
    } catch (err) {
      warnings.push(
        `пост вышел, но продолжение текста (${tails.length - i} из ${tails.length} сообщ.${button ? ', с кнопкой' : ''}) не отправлено — ${err.message}. Дошлите его в канал руками`
      );
      break;
    }
  }

  // Закреп — после всего: пост уже вышел, и неудача закрепа его не отменяет.
  if (options.pin) {
    try {
      if (!(await pin(chatId, ids[0], creds))) {
        warnings.push('пост закреплён, но служебное «закреплено» в ленте канала убрать не удалось — удалите его руками');
      }
    } catch (err) {
      warnings.push(`пост вышел, но не закрепился — ${err.message}. Нужно право «Изменение публикаций» у бота`);
    }
  }

  out.externalId = ids.join(',');
  if (warnings.length) out.warning = warnings.join('; ');
  return out;
}

/**
 * Закрепить и убрать служебное «закреплено» из ленты канала.
 *
 * 13.09.2026 проба показала: закреп в канале добавляет в ленту служебное
 * сообщение, и после удаления поста оно оставалось висеть. Его id Bot API не
 * возвращает — ищем в обновлениях бота запись, которая ссылается ровно на наш
 * пост. «Следующий id после поста» не годится: между ними мог выйти чужой пост.
 *
 * @returns {Promise<boolean>} удалось ли убрать служебное сообщение
 */
async function pin(chatId, messageId, creds) {
  const form = new FormData();
  form.set('chat_id', chatId);
  form.set('message_id', String(messageId));
  // Закреп в канале сам присылает подписчикам уведомление — второе незачем.
  form.set('disable_notification', 'true');
  await call('pinChatMessage', form, creds);
  return dropPinNotice(chatId, messageId, creds);
}

/** Тот ли это чат: `@имя` сверяем с username, числовой id — с id. */
function sameChat(chatId, chat) {
  if (!chat) return false;
  const id = String(chatId);
  if (id.startsWith('@')) return String(chat.username || '').toLowerCase() === id.slice(1).toLowerCase();
  return String(chat.id) === id;
}

/**
 * Обновления бота по кругу, пока не кончатся. Прочитанное подтверждается
 * (`offset`): другого читателя обновлений у бота панели нет, а без
 * подтверждения очередь в 100 записей однажды заслонила бы нужную.
 */
export async function readUpdates(creds, { onUpdate, rounds = 5, peek = false } = {}) {
  let offset = 0;
  // peek — только посмотреть первые 100, ничего не подтверждая.
  for (let i = 0; i < (peek ? 1 : rounds); i++) {
    const form = new FormData();
    if (offset) form.set('offset', String(offset));
    form.set('timeout', '0');
    form.set('allowed_updates', JSON.stringify(['channel_post', 'message']));
    const updates = await call('getUpdates', form, creds);
    if (!updates.length) return;
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      if (onUpdate?.(u) === true) {
        // Нашли — подтверждаем прочитанное и выходим.
        const ack = new FormData();
        ack.set('offset', String(offset));
        ack.set('timeout', '0');
        await call('getUpdates', ack, creds).catch(() => {});
        return;
      }
    }
  }
}

async function dropPinNotice(chatId, messageId, creds, { tries = 4, pauseMs = 700 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    let notice = null;
    try {
      await readUpdates(creds, {
        onUpdate: (u) => {
          const post = u.channel_post || u.message;
          if (post?.pinned_message?.message_id === Number(messageId) && sameChat(chatId, post.chat)) {
            notice = post.message_id;
            return true;
          }
          return false;
        },
      });
    } catch {
      return false; // вебхук у бота или сбой — служебное сообщение останется, скажем об этом
    }
    if (notice) {
      try {
        await remove(String(notice), { ...creds, chatId });
        return true;
      } catch {
        return false;
      }
    }
    await sleep(pauseMs);
  }
  return false;
}

/**
 * Обновить вышедший пост: текст (подпись), кнопку, превью ссылки и закреп.
 *
 * Медиа не меняются — это другой пост. Сообщения поста раскладываются так:
 * сначала файлы (у альбома — по сообщению на файл, подпись у первого), потом
 * продолжение текста. Если новый текст требует больше сообщений, чем вышло,
 * — отказ: дописать сообщение в середину ленты канала нельзя, оно встанет в
 * конец, после чужих постов. Лишние хвосты, наоборот, удаляются.
 *
 * @returns {Promise<{externalId: string, warning?: string}>}
 */
export async function edit(externalId, { text, media = [], creds, options = {} }) {
  const chatId = normalizeChatId(creds.chatId);
  const ids = String(externalId ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const fileMessages = media.length > 1 ? Math.min(media.length, 10) : media.length;
  if (!ids.length || ids.length < Math.max(fileMessages, 1)) {
    throw new Error('Telegram: у поста не хватает id сообщений — обновить нечего, опубликуйте заново');
  }

  const body = String(text || '').trim();
  const button = options.button?.text && options.button?.url ? options.button : null;
  const parts = splitText(body, media.length ? CAPTION_LIMIT : TEXT_LIMIT);

  // Слоты текста: у поста с файлами — подпись первого файла и хвосты после
  // файлов; у текстового — все сообщения.
  const slots = media.length
    ? [{ id: ids[0], caption: true }, ...ids.slice(fileMessages).map((id) => ({ id }))]
    : ids.map((id) => ({ id }));
  const needed = Math.max(parts.length, media.length ? 1 : 1);
  if (needed > slots.length) {
    throw new Error(
      `Новый текст уйдёт ${needed} сообщениями, а в канале их ${slots.length} — дописать в середину канала нельзя. Сократите текст или опубликуйте пост заново`
    );
  }

  const kept = slots.slice(0, needed);
  const extra = slots.slice(needed);
  const album = media.length > 1;
  const warnings = [];

  for (const [i, slot] of kept.entries()) {
    const last = i === kept.length - 1;
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('message_id', String(slot.id));
    // Клавиатуру ставим последнему, у альбома её не бывает.
    const markup = last && !(album && slot.caption) ? keyboard(button) : null;
    if (slot.caption) {
      form.set('caption', parts[i] || '');
      if (markup) form.set('reply_markup', markup);
      await callEdit('editMessageCaption', form, creds);
    } else {
      form.set('text', parts[i]);
      if (options.noPreview) form.set('link_preview_options', NO_PREVIEW);
      if (markup) form.set('reply_markup', markup);
      await callEdit('editMessageText', form, creds);
    }
  }
  if (button && album && kept.length === 1) warnings.push('к альбому кнопку Telegram не прикрепляет');

  for (const slot of extra) {
    try {
      await remove(slot.id, creds);
    } catch (err) {
      warnings.push(`лишнее продолжение (сообщение ${slot.id}) не удалилось — ${err.message}`);
    }
  }

  // Закреп: поставить или снять. Снятие незакреплённого Telegram может
  // отвергнуть — это не ошибка правки.
  try {
    if (options.pin) {
      // Уже закреплённый не закрепляем заново: каждый закреп — новое
      // служебное сообщение в ленте.
      const chatForm = new FormData();
      chatForm.set('chat_id', chatId);
      const chat = await call('getChat', chatForm, creds);
      if (String(chat.pinned_message?.message_id) !== String(ids[0]) && !(await pin(chatId, ids[0], creds))) {
        warnings.push('пост закреплён, но служебное «закреплено» в ленте канала убрать не удалось — удалите его руками');
      }
    } else {
      const form = new FormData();
      form.set('chat_id', chatId);
      form.set('message_id', String(ids[0]));
      await call('unpinChatMessage', form, creds);
    }
  } catch (err) {
    if (options.pin) warnings.push(`текст обновлён, но пост не закрепился — ${err.message}`);
  }

  const leftIds = ids.filter((id) => !extra.some((s) => String(s.id) === id));
  const out = { externalId: leftIds.join(',') };
  if (warnings.length) out.warning = warnings.join('; ');
  return out;
}

/** «Ничего не изменилось» при правке — не ошибка. */
async function callEdit(method, form, creds) {
  try {
    await call(method, form, creds);
  } catch (err) {
    if (!/message is not modified/i.test(err.message)) throw err;
  }
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
