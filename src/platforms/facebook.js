/**
 * Facebook, публикация на страницу. Код написан по документации и НЕ проверен.
 *
 * Текст и фото уходят одним вызовом, в отличие от Instagram. Reels — отдельный
 * трёхшаговый порядок (start → upload → finish), он здесь намеренно не сделан:
 * до него дойдём, когда появится вторая машина и перекодирование видео.
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

export async function publish({ text, media = [], publicUrl, creds }) {
  const page = creds.pageId;

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
