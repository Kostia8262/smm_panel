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

/**
 * Поиск по публичным постам Threads.
 *
 * Единственный законный способ увидеть, о чём сейчас пишут: у Threads нет
 * ни ленты трендов, ни хэштег-статистики. Важное ограничение — поиск НЕ
 * отдаёт цифры вовлечённости: ни лайков, ни ответов. Только текст, автор,
 * ссылка и время.
 *
 * Косвенный признак «зашло» всё же есть: `search_type=TOP` — это то, что
 * Meta сама сочла лучшим по запросу. Сравнение TOP и RECENT показывает,
 * какие посты площадка подняла, а какие просто свежие.
 *
 * Без разрешения `threads_keyword_search`, прошедшего App Review, поиск
 * видит только собственные посты аккаунта — то есть для трендов бесполезен.
 */
export async function keywordSearch(creds, { q, type = 'TOP', limit = 50, since = null } = {}) {
  if (!creds?.accessToken) throw new Error('Нет токена Threads');
  const params = new URLSearchParams({
    q,
    search_type: type,
    limit: String(Math.min(100, limit)),
    fields: 'id,text,username,permalink,timestamp,media_type,is_reply,is_quote_post,has_replies',
    access_token: creds.accessToken,
  });
  if (since) params.set('since', String(Math.floor(new Date(since).getTime() / 1000)));

  const res = await fetch(`${API}/keyword_search?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Threads поиск: ${data.error?.message || res.status}`);
  }
  // Ответы и цитаты — шум: нас интересует, что люди публикуют сами.
  return (data.data || []).filter((p) => !p.is_reply);
}

/** Показатели нашего поста: из них и считается, что у нас заходит. */
export async function insights(creds, mediaId) {
  const metrics = 'views,likes,replies,reposts,quotes';
  const res = await fetch(
    `${API}/${mediaId}/insights?metric=${metrics}&access_token=${creds.accessToken}`
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Threads insights: ${data.error?.message || res.status}`);

  const out = {};
  for (const row of data.data || []) {
    out[row.name] = row.values?.[0]?.value ?? row.total_value?.value ?? 0;
  }
  return out;
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
