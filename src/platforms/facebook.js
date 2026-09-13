/**
 * Facebook, публикация на страницу.
 *
 * Текст и фото уходят одним вызовом, в отличие от Instagram — боем проверено
 * 12.09.2026. Reels — отдельный порядок из четырёх шагов, см. `publishReel`.
 *
 * Перекодирования здесь нет и не будет: файл должен прийти уже в формате
 * Reels (9:16, H.264, AAC). Перекодировать — работа второй машины, не VPS.
 */

import { GRAPH_API as API, RUPLOAD_API } from './graph.js';

export const id = 'facebook';

export function isConfigured(creds = {}) {
  return Boolean(creds.pageId && creds.pageToken);
}

export function missingConfig(creds = {}) {
  const missing = [];
  if (!creds.pageId) missing.push('ID страницы');
  if (!creds.pageToken) missing.push('токен страницы');
  return missing;
}

async function call(path, params, creds) {
  const body = new URLSearchParams({ ...params, access_token: creds.pageToken });
  const res = await fetch(`${API}/${path}`, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Facebook ${path}: ${data.error?.message || res.status}`);
  }
  return data;
}

export async function check(creds) {
  const res = await fetch(`${API}/${creds.pageId}?fields=name,fan_count&access_token=${creds.pageToken}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { ok: true, account: data.name };
}

/**
 * Два срока токена страницы — это читает сторож.
 *
 *   expiresAt           — срок самого токена; 0 от площадки — бессрочный (null);
 *   dataAccessExpiresAt — правило Meta «90 дней без входа в приложение»: токен
 *                         может быть бессрочным, а доступ к данным — кончиться.
 */
export async function tokenLifetime(creds) {
  const appToken = `${creds.appId}|${creds.appSecret}`;
  const res = await fetch(`${API}/debug_token?input_token=${creds.pageToken}&access_token=${appToken}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);
  return { expiresAt: iso(data.data?.expires_at), dataAccessExpiresAt: iso(data.data?.data_access_expires_at) };
}

/** Когда протухает токен страницы. Оставлено для вызовов, которым нужен только срок. */
export async function tokenExpiry(creds) {
  return (await tokenLifetime(creds)).expiresAt;
}

/**
 * Снять пост со страницы.
 *
 * Документация Meta оговаривает: «only select developers can perform this
 * operation» — то есть отказ здесь возможен и при верном токене. Значит
 * нельзя считать удаление само собой разумеющимся: если не вышло, пост
 * придётся снимать руками, и сказать об этом надо вслух.
 *
 * Нужен `pages_manage_posts`. С одним `pages_manage_engagement` вызов
 * вернёт ошибку прав, а не «удалено».
 */
export async function remove(externalId, creds) {
  const res = await fetch(`${API}/${externalId}?access_token=${creds.pageToken}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Facebook удаление: ${data.error?.message || res.status}`);
  }
  return { ok: Boolean(data.success ?? true) };
}

/**
 * Reels на страницу — отдельный API, не `/videos`.
 *
 * До 12.09.2026 формат «Reels» в панели был, а видео уходило обычным
 * видеопостом через `/videos`: в ленте оно выглядело иначе, в раздел Reels не
 * попадало, и никто бы этого не заметил, пока не открыл страницу.
 *
 * Порядок по документации Meta:
 *   1. start  — площадка заводит объект видео и отдаёт его id;
 *   2. upload — на rupload.facebook.com передаём АДРЕС файла, не байты:
 *      Facebook скачивает его сам (заголовок `file_url`);
 *   3. ждём, пока загрузка завершится — иначе finish отвечает ошибкой;
 *   4. finish — публикуем с подписью.
 *
 * Ограничения площадки: 3–90 секунд, 9:16, не больше 30 Reels через API за
 * сутки на страницу.
 */
export async function publishReel({ text, video, publicUrl, creds, waitMs = 5000, tries = 36 }) {
  const page = creds.pageId;

  const start = await call(`${page}/video_reels`, { upload_phase: 'start' }, creds);
  const videoId = start.video_id;
  if (!videoId) throw new Error('Facebook Reels: площадка не выдала id видео');

  await uploadByUrl(`${RUPLOAD_API}/${videoId}`, publicUrl(video), creds, 'Facebook Reels');
  await waitUploaded(videoId, creds, { waitMs, tries, label: 'Facebook Reels' });

  await call(
    `${page}/video_reels`,
    { upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: text },
    creds
  );
  return { externalId: videoId, url: `https://www.facebook.com/reel/${videoId}` };
}

/** Передать площадке адрес файла: Facebook скачивает его сам (заголовок `file_url`). */
async function uploadByUrl(uploadUrl, fileUrl, creds, label) {
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `OAuth ${creds.pageToken}`, file_url: fileUrl },
  });
  const upData = await up.json().catch(() => ({}));
  if (!up.ok || upData.error || upData.success === false) {
    throw new Error(`${label} загрузка: ${upData.error?.message || upData.debug_info?.message || up.status}`);
  }
}

/**
 * Загрузка по адресу идёт в фоне: площадка ответила «принято», а скачивать
 * ещё только начала. Шаг finish до её конца отбивается.
 */
async function waitUploaded(videoId, creds, { waitMs, tries, label }) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${API}/${videoId}?fields=status&access_token=${creds.pageToken}`);
    const data = await res.json().catch(() => ({}));
    const status = data.status || {};
    if (status.video_status === 'error' || status.uploading_phase?.status === 'error') {
      const reason = status.uploading_phase?.errors?.[0]?.message || status.processing_phase?.errors?.[0]?.message;
      throw new Error(`${label}: площадка не приняла файл${reason ? ` — ${reason}` : ''}`);
    }
    if (status.uploading_phase?.status === 'complete' || status.uploading_phase?.status === 'completed') return;
    if (i === tries - 1) throw new Error(`${label}: загрузка не завершилась за отведённое время`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/**
 * Сторис страницы — один кадр за вызов. Серию разбирает очередь, как и у
 * Instagram (queue/publish.js).
 *
 * До 13.09.2026 сторис Facebook в панели не было вовсе, хотя у страницы API
 * есть (документация Meta, Page Stories API):
 *   фото  — загрузить неопубликованным через `/photos`, затем
 *           `/photo_stories` с `photo_id`;
 *   видео — `/video_stories`: start → загрузка по адресу → finish, тот же
 *           порядок, что у Reels, и то же ожидание загрузки перед finish.
 * Оба отвечают `{ success, post_id }`. Видео — 3–60 секунд, 9:16.
 * Разрешение — `pages_manage_posts`, оно у токена страницы уже есть.
 */
export async function publishStory({ item, publicUrl, creds, waitMs = 5000, tries = 36 }) {
  const page = creds.pageId;

  if (item.kind !== 'video') {
    const photo = await call(`${page}/photos`, { url: publicUrl(item), published: 'false' }, creds);
    const res = await call(`${page}/photo_stories`, { photo_id: photo.id }, creds);
    if (res.success === false) throw new Error('Facebook сторис: площадка не опубликовала кадр');
    return { externalId: res.post_id || photo.id, url: null };
  }

  const start = await call(`${page}/video_stories`, { upload_phase: 'start' }, creds);
  const videoId = start.video_id;
  if (!videoId) throw new Error('Facebook сторис: площадка не выдала id видео');

  await uploadByUrl(
    start.upload_url || `${RUPLOAD_API}/${videoId}`,
    publicUrl(item),
    creds,
    'Facebook сторис'
  );
  await waitUploaded(videoId, creds, { waitMs, tries, label: 'Facebook сторис' });

  const res = await call(`${page}/video_stories`, { upload_phase: 'finish', video_id: videoId }, creds);
  if (res.success === false) throw new Error('Facebook сторис: площадка не опубликовала ролик');
  return { externalId: res.post_id || videoId, url: null };
}

export async function publish({ text, media = [], formatId, publicUrl, creds }) {
  const page = creds.pageId;

  if (formatId === 'story') {
    if (media.length !== 1) throw new Error('Facebook: сторис публикуется по одному кадру — серию разбирает очередь');
    return publishStory({ item: media[0], publicUrl, creds });
  }

  if (formatId === 'reels') {
    const video = media.find((m) => m.kind === 'video');
    // Reels без видео не бывает, и молча опубликовать вместо него фото —
    // значит выдать не тот формат, который человек выбрал.
    if (!video) throw new Error('Facebook Reels: нужен видеофайл');
    return publishReel({ text, video, publicUrl, creds });
  }

  // Альбом собирается только из фото, и видео в нём до 13.09.2026 молча
  // пропускалось: пост выходил без ролика. Валидатор такое не пускает, а
  // здесь — последний рубеж на случай поста, поставленного в очередь раньше.
  if (media.length > 1 && media.some((m) => m.kind === 'video')) {
    throw new Error('Facebook: несколько файлов уходят фотоальбомом — видео в нём не опубликуется');
  }

  if (!media.length) {
    const res = await call(`${page}/feed`, { message: text }, creds);
    return { externalId: res.id, url: `https://facebook.com/${res.id}` };
  }

  if (media.length === 1 && media[0].kind === 'image') {
    const res = await call(`${page}/photos`, { url: publicUrl(media[0]), caption: text }, creds);
    return { externalId: res.post_id || res.id, url: null };
  }

  if (media.length === 1 && media[0].kind === 'video') {
    const res = await call(`${page}/videos`, { file_url: publicUrl(media[0]), description: text }, creds);
    return { externalId: res.id, url: null };
  }

  // Несколько фото: сперва загрузить неопубликованными, затем собрать пост.
  const ids = [];
  for (const m of media.slice(0, 10)) {
    if (m.kind !== 'image') continue;
    const up = await call(`${page}/photos`, { url: publicUrl(m), published: 'false' }, creds);
    ids.push(up.id);
  }
  const params = { message: text };
  ids.forEach((id, i) => {
    params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
  });
  const res = await call(`${page}/feed`, params, creds);
  return { externalId: res.id, url: `https://facebook.com/${res.id}` };
}
