/**
 * Facebook, публикация на страницу.
 *
 * Текст и фото уходят одним вызовом, в отличие от Instagram — боем проверено
 * 12.09.2026. Reels — отдельный порядок из четырёх шагов, см. `publishReel`.
 *
 * Перекодирования здесь нет и не будет: файл должен прийти уже в формате
 * Reels (9:16, H.264, AAC). Перекодировать — работа второй машины, не VPS.
 */

const API = 'https://graph.facebook.com/v21.0';

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

/** Когда протухает токен страницы — это читает сторож. */
export async function tokenExpiry(creds) {
  const appToken = `${creds.appId}|${creds.appSecret}`;
  const res = await fetch(`${API}/debug_token?input_token=${creds.pageToken}&access_token=${appToken}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const expires = data.data?.expires_at;
  return expires ? new Date(expires * 1000).toISOString() : null; // 0 = бессрочный system user token
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

  const up = await fetch(`https://rupload.facebook.com/video-upload/v21.0/${videoId}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${creds.pageToken}`, file_url: publicUrl(video) },
  });
  const upData = await up.json().catch(() => ({}));
  if (!up.ok || upData.error || upData.success === false) {
    throw new Error(`Facebook Reels загрузка: ${upData.error?.message || upData.debug_info?.message || up.status}`);
  }

  // Загрузка по адресу идёт в фоне: площадка ответила «принято», а скачивать
  // ещё только начала. Шаг finish до её конца отбивается.
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${API}/${videoId}?fields=status&access_token=${creds.pageToken}`);
    const data = await res.json().catch(() => ({}));
    const status = data.status || {};
    if (status.video_status === 'error' || status.uploading_phase?.status === 'error') {
      const reason = status.uploading_phase?.errors?.[0]?.message || status.processing_phase?.errors?.[0]?.message;
      throw new Error(`Facebook Reels: площадка не приняла файл${reason ? ` — ${reason}` : ''}`);
    }
    if (status.uploading_phase?.status === 'complete' || status.uploading_phase?.status === 'completed') break;
    if (i === tries - 1) throw new Error('Facebook Reels: загрузка не завершилась за отведённое время');
    await new Promise((r) => setTimeout(r, waitMs));
  }

  await call(
    `${page}/video_reels`,
    { upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: text },
    creds
  );
  return { externalId: videoId, url: `https://www.facebook.com/reel/${videoId}` };
}

export async function publish({ text, media = [], formatId, publicUrl, creds }) {
  const page = creds.pageId;

  if (formatId === 'reels') {
    const video = media.find((m) => m.kind === 'video');
    // Reels без видео не бывает, и молча опубликовать вместо него фото —
    // значит выдать не тот формат, который человек выбрал.
    if (!video) throw new Error('Facebook Reels: нужен видеофайл');
    return publishReel({ text, video, publicUrl, creds });
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
