/**
 * Threads. Публикация в два шага: создать контейнер, затем опубликовать его.
 *
 * Код написан по документации, но НЕ проверен живым токеном — до первого
 * успешного поста считать черновиком. Что почти наверняка придётся поправить:
 * версию API в URL и точные имена полей ответа.
 *
 * Медиа площадка забирает сама по публичному URL — значит файл должен быть
 * доступен снаружи, отсюда PUBLIC_BASE_URL в окружении.
 */

const API = 'https://graph.threads.net/v1.0';

export const id = 'threads';

export function isConfigured(creds = {}) {
  return Boolean(creds.userId && creds.accessToken);
}

export function missingConfig(creds = {}) {
  const missing = [];
  if (!creds.userId) missing.push('ID аккаунта');
  if (!creds.accessToken) missing.push('токен доступа (живёт 60 дней)');
  return missing;
}

async function call(path, params, creds) {
  const body = new URLSearchParams({ ...params, access_token: creds.accessToken });
  const res = await fetch(`${API}/${path}`, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Threads ${path}: ${data.error?.message || res.status}`);
  }
  return data;
}

export async function check(creds) {
  const res = await fetch(`${API}/me?fields=id,username&access_token=${creds.accessToken}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { ok: true, account: data.username };
}

export async function publish({ text, media = [], publicUrl, creds }) {
  const user = creds.userId;
  let containerId;

  if (!media.length) {
    ({ id: containerId } = await call(`${user}/threads`, { media_type: 'TEXT', text }, creds));
  } else if (media.length === 1) {
    const m = media[0];
    const isVideo = m.kind === 'video';
    ({ id: containerId } = await call(`${user}/threads`, {
      media_type: isVideo ? 'VIDEO' : 'IMAGE',
      [isVideo ? 'video_url' : 'image_url']: publicUrl(m),
      text,
    }, creds));
  } else {
    // Карусель: контейнер на каждый файл, затем общий.
    const children = [];
    for (const m of media.slice(0, 20)) {
      const isVideo = m.kind === 'video';
      const child = await call(`${user}/threads`, {
        media_type: isVideo ? 'VIDEO' : 'IMAGE',
        [isVideo ? 'video_url' : 'image_url']: publicUrl(m),
        is_carousel_item: 'true',
      }, creds);
      children.push(child.id);
    }
    ({ id: containerId } = await call(`${user}/threads`, {
      media_type: 'CAROUSEL',
      children: children.join(','),
      text,
    }, creds));
  }

  // Видео обрабатывается не мгновенно; публикацию делаем с паузой.
  if (media.some((m) => m.kind === 'video')) await new Promise((r) => setTimeout(r, 30000));

  const published = await call(`${user}/threads_publish`, { creation_id: containerId }, creds);
  return { externalId: published.id, url: null };
}
