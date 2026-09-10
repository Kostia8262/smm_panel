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

export function isConfigured() {
  return Boolean(process.env.THREADS_USER_ID && process.env.THREADS_ACCESS_TOKEN);
}

export function missingConfig() {
  const missing = [];
  if (!process.env.THREADS_USER_ID) missing.push('THREADS_USER_ID');
  if (!process.env.THREADS_ACCESS_TOKEN) missing.push('THREADS_ACCESS_TOKEN (живёт 60 дней)');
  return missing;
}

async function call(path, params) {
  const token = process.env.THREADS_ACCESS_TOKEN;
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${API}/${path}`, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Threads ${path}: ${data.error?.message || res.status}`);
  }
  return data;
}

export async function check() {
  const token = process.env.THREADS_ACCESS_TOKEN;
  const res = await fetch(`${API}/me?fields=id,username&access_token=${token}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { ok: true, account: data.username };
}

export async function publish({ text, media = [], publicUrl }) {
  const user = process.env.THREADS_USER_ID;
  let containerId;

  if (!media.length) {
    ({ id: containerId } = await call(`${user}/threads`, { media_type: 'TEXT', text }));
  } else if (media.length === 1) {
    const m = media[0];
    const isVideo = m.kind === 'video';
    ({ id: containerId } = await call(`${user}/threads`, {
      media_type: isVideo ? 'VIDEO' : 'IMAGE',
      [isVideo ? 'video_url' : 'image_url']: publicUrl(m),
      text,
    }));
  } else {
    // Карусель: контейнер на каждый файл, затем общий.
    const children = [];
    for (const m of media.slice(0, 20)) {
      const isVideo = m.kind === 'video';
      const child = await call(`${user}/threads`, {
        media_type: isVideo ? 'VIDEO' : 'IMAGE',
        [isVideo ? 'video_url' : 'image_url']: publicUrl(m),
        is_carousel_item: 'true',
      });
      children.push(child.id);
    }
    ({ id: containerId } = await call(`${user}/threads`, {
      media_type: 'CAROUSEL',
      children: children.join(','),
      text,
    }));
  }

  // Видео обрабатывается не мгновенно; публикацию делаем с паузой.
  if (media.some((m) => m.kind === 'video')) await new Promise((r) => setTimeout(r, 30000));

  const published = await call(`${user}/threads_publish`, { creation_id: containerId });
  return { externalId: published.id, url: null };
}
