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

/**
 * Продлить долгоживущий токен. Threads — единственная наша площадка, которая
 * умеет это сама, без похода человека в настройки приложения.
 *
 * Условия площадки, и все три важны:
 *   — токену должно быть **больше суток**: свежевыпущенный продлить нельзя;
 *   — он не должен быть истёкшим: **после смерти продлевать уже нечего**,
 *     выпускать придётся заново руками;
 *   — приложению должно быть выдано `threads_basic`.
 *
 * Новый токен живёт 60 дней **от дня продления**, а не от старого срока:
 * тянуть до последнего смысла нет, ничего этим не выигрывается.
 *
 * Возвращает поля в том же виде, в каком их принимает карточка проекта, —
 * сторож не должен знать, как у Threads называется поле с токеном.
 */
export async function renew(creds) {
  if (!creds?.accessToken) throw new Error('Нет токена Threads');
  const params = new URLSearchParams({
    grant_type: 'th_refresh_token',
    access_token: creds.accessToken,
  });

  const res = await fetch(`${API}/refresh_access_token?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Threads продление: ${data.error?.message || res.status}`);
  }
  if (!data.access_token) throw new Error('Threads продление: площадка не вернула новый токен');

  return { values: { accessToken: data.access_token }, expiresIn: Number(data.expires_in) || null };
}

/**
 * Проверка связи. Ходит на `me`, а не на вписанный id — площадка сама знает,
 * чей токен ей дали.
 *
 * Отсюда важное: связь может быть, а публикация падать, потому что публикация
 * идёт на `creds.userId`. Ровно это и случилось в первой боевой пробе. Поэтому
 * возвращаем ещё и настоящий id — вызывающий обязан сверить его с тем, что
 * вписано в карточку, иначе панель говорит «подключено» про то, что не
 * работает.
 */
export async function check(creds) {
  const res = await fetch(`${API}/me?fields=id,username&access_token=${creds.accessToken}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { ok: true, account: data.username, id: data.id };
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

/**
 * Удалить свой пост.
 *
 * Требует отдельного разрешения `threads_delete` — одного `threads_basic`
 * мало. Удалять можно только посты того аккаунта, чьим токеном ходим.
 *
 * Ограничение площадки: **сто удалений в сутки на аккаунт**. Для панели это
 * не помеха, но чистить историю пачкой через неё не выйдет.
 */
export async function remove(externalId, creds) {
  const res = await fetch(`${API}/${externalId}?access_token=${creds.accessToken}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Threads удаление: ${data.error?.message || res.status}`);
  }
  return { ok: Boolean(data.success ?? true), deletedId: data.deleted_id || externalId };
}

/**
 * Дождаться, пока контейнер станет FINISHED.
 *
 * Картинку Threads скачивает с нашего сервера в фоне, как и Instagram, и
 * `threads_publish` по неготовому контейнеру отвечает «The requested resource
 * does not exist» — на этом 13.09.2026 упала первая проба картинки. До этого
 * ожидание стояло только у видео, и то слепым сном на 30 секунд: короткий
 * ролик ждал зря, длинный не успевал.
 *
 * Шаг опроса разный: картинка готова за секунды, видео — за минуты.
 */
export async function waitReady(containerId, creds, { tries = 15, pauseMs = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${API}/${containerId}?fields=status,error_message&access_token=${creds.accessToken}`);
    const data = await res.json().catch(() => ({}));
    if (data.status === 'FINISHED') return;
    // Причина — в error_message, текстом: чаще всего площадка не смогла
    // скачать файл или не приняла его формат.
    if (data.status === 'ERROR' || data.status === 'EXPIRED') {
      throw new Error(`Threads: контейнер не собрался — ${data.error_message || data.status}`);
    }
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  throw new Error('Threads: контейнер не дошёл до готовности за отведённое время');
}

export async function publish({ text, media = [], publicUrl, creds, pauseMs }) {
  const user = creds.userId;
  let containerId;
  const heavy = media.some((m) => m.kind === 'video');
  // Опрос у видео редкий и долгий, у картинки частый и короткий.
  const wait = heavy ? { tries: 36, pauseMs: pauseMs ?? 10000 } : { tries: 15, pauseMs: pauseMs ?? 2000 };

  if (!media.length) {
    // Текст ничего не скачивает — ждать нечего, и проба 13.09 это подтвердила.
    ({ id: containerId } = await call(`${user}/threads`, { media_type: 'TEXT', text }, creds));
  } else if (media.length === 1) {
    const m = media[0];
    const isVideo = m.kind === 'video';
    ({ id: containerId } = await call(`${user}/threads`, {
      media_type: isVideo ? 'VIDEO' : 'IMAGE',
      [isVideo ? 'video_url' : 'image_url']: publicUrl(m),
      text,
    }, creds));
    await waitReady(containerId, creds, wait);
  } else {
    // Карусель: контейнер на каждый файл, затем общий. Каждый кадр должен
    // собраться до того, как из них собирают карусель, — иначе площадка
    // отбивает общий контейнер.
    const children = [];
    for (const m of media.slice(0, 20)) {
      const isVideo = m.kind === 'video';
      const child = await call(`${user}/threads`, {
        media_type: isVideo ? 'VIDEO' : 'IMAGE',
        [isVideo ? 'video_url' : 'image_url']: publicUrl(m),
        is_carousel_item: 'true',
      }, creds);
      await waitReady(child.id, creds, wait);
      children.push(child.id);
    }
    ({ id: containerId } = await call(`${user}/threads`, {
      media_type: 'CAROUSEL',
      children: children.join(','),
      text,
    }, creds));
    await waitReady(containerId, creds, wait);
  }

  const published = await call(`${user}/threads_publish`, { creation_id: containerId }, creds);
  return { externalId: published.id, url: null };
}
